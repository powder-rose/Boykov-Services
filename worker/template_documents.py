"""Word template preparation. Only existing, trusted replacement macros are used."""
from __future__ import annotations

from copy import deepcopy
from difflib import SequenceMatcher
from io import BytesIO
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import unquote, urlsplit
from zipfile import BadZipFile, ZipFile, ZIP_DEFLATED

from lxml import etree

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'
CT = '{http://schemas.openxmlformats.org/package/2006/content-types}'
NS = {'w': W[1:-1]}
DOC = 'word/document.xml'
DOC_RELS = 'word/_rels/document.xml.rels'
CONTENT = '[Content_Types].xml'
DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
DOCM_TYPE = 'application/vnd.ms-word.document.macroEnabled.main+xml'
MAX_FILE = 20 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
TAG = re.compile(r'autozamena_\d{3}(?!\d)', re.I)
INVALID_TAG = re.compile(r'autozamena_(?:\d{4,}|\d{1,2}(?!\d)|[a-zA-Z_][a-zA-Z0-9_]*)', re.I)
STORY = re.compile(r'word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml\Z')
FILES = {
    'passport_security': 'ООО СПЕЦКОНС_ПАСПОРТ БЕЗОПАСНОСТИ.docm',
    'passport_security_agreed': 'ООО СПЕЦКОНС_ПАСПОРТ БЕЗОПАСНОСТИ С СОГЛАСОВАНИЕМ.docm',
    'sout': 'ООО СПЕЦКОНС_СОУТ.docm',
    'specons': 'template2.docm',
    'ser': 'ООО СПЕЦЭНЕРГОРАЗВИТИЕ.docm',
    'ser_one_time': 'ООО СПЕЦЭНЕРГОРАЗВИТИЕ_РАЗОВЫЕ.docm',
}
PASSIVE_EXTENSIONS = {
    '.xml', '.rels', '.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tif', '.tiff',
    '.wmf', '.emf', '.odttf', '.svg',
}
ACTIVE_RELATIONS = {
    'vbaProject', 'wordVbaData', 'control', 'activeXControlBinary',
    'vbaProjectSignature', 'vbaProjectSignatureAgile', 'vbaProjectSignatureV3',
}


class TemplateError(ValueError):
    pass


def xml(data):
    try:
        root = etree.fromstring(data, etree.XMLParser(
            resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False,
        ))
        if root.getroottree().docinfo.doctype:
            raise TemplateError('DTD в документах не поддерживается.')
        return root
    except etree.XMLSyntaxError as exc:
        raise TemplateError('Повреждена XML-структура файла Word.') from exc


def serialize(root):
    return etree.tostring(root, encoding='UTF-8', xml_declaration=True, standalone=True)


def unpack(raw):
    if not raw or len(raw) > MAX_FILE:
        raise TemplateError('Выберите файл Word размером до 20 МБ.')
    try:
        with ZipFile(BytesIO(raw)) as source:
            items = source.infolist()
            if len(items) > 2000 or sum(i.file_size for i in items) > MAX_EXPANDED:
                raise TemplateError('Документ слишком большой после распаковки.')
            files = {}
            names = set()
            for item in items:
                if item.is_dir():
                    continue
                name = item.filename
                if ('\\' in name or name.startswith('/') or '..' in PurePosixPath(name).parts
                        or name.casefold() in names or item.flag_bits & 1):
                    raise TemplateError('Некорректная структура файла Word.')
                names.add(name.casefold())
                files[name] = source.read(item)
            if not {DOC, CONTENT, DOC_RELS, '_rels/.rels'} <= files.keys():
                raise TemplateError('Нужен документ Microsoft Word DOCX или DOCM.')
            return files
    except (BadZipFile, NotImplementedError, RuntimeError, OSError) as exc:
        raise TemplateError('Не удалось прочитать файл Word.') from exc


def pack(files):
    buffer = BytesIO()
    with ZipFile(buffer, 'w', ZIP_DEFLATED) as target:
        for name, data in files.items():
            target.writestr(name, data)
    result = buffer.getvalue()
    if len(result) > MAX_FILE or sum(map(len, files.values())) > MAX_EXPANDED:
        raise TemplateError('Подготовленный шаблон слишком большой.')
    return result


def text(element):
    return ''.join(element.xpath('.//w:t/text()', namespaces=NS))


def body(root):
    if root.tag != W + 'document' or root.find(W + 'body') is None:
        raise TemplateError('Не найден основной текст документа.')
    return root.find(W + 'body')


def cells(row):
    return [child for child in row if child.tag in {W + 'tc', W + 'sdt'}]


def service_tables(root):
    """Recognize only the existing five-column service table, not contract tables."""
    result = []
    for table in body(root).findall(W + 'tbl'):
        rows = table.findall(W + 'tr')
        if len(rows) < 3:
            continue
        header = text(rows[0]).upper()
        if 'АВТОЗАМЕНА' not in header or 'ДАННЫЕ ДЛЯ ЗАМЕНЫ' not in header:
            continue
        result.append(table)
    return result


def table_fields(table):
    result = []
    for row in table.findall(W + 'tr')[2:]:
        columns = cells(row)
        if len(columns) != 5 or not re.fullmatch(r'autozamena_\d{3}', text(columns[4]).strip()):
            raise TemplateError('Нарушена структура таблицы автозамен.')
        key = text(columns[4]).strip()
        result.append({'key': key, 'label': text(columns[1]).strip()})
    if not result or len({field['key'] for field in result}) != len(result):
        raise TemplateError('Повторяющиеся поля в таблице автозамен.')
    return result


def active_part(name):
    return ('/activex/' in name.lower() or 'vbaproject' in name.lower()
            or 'vbadata' in name.lower())


def rel_type(node):
    return (node.get('Type') or '').rsplit('/', 1)[-1]


def resolve_target(rels_name, target):
    base = '' if rels_name == '_rels/.rels' else posixpath.dirname(posixpath.dirname(rels_name))
    path = unquote(target)
    path = path.lstrip('/') if path.startswith('/') else posixpath.normpath(posixpath.join(base, path))
    if path.startswith('../') or '\\' in path or ':' in path:
        raise TemplateError('Некорректная внутренняя ссылка документа.')
    return path


def check_package(files, *, trusted=None):
    """Validate a passive package or a package rebuilt with the trusted bundle."""
    trusted = trusted or {}
    for name, raw in files.items():
        if name.lower().startswith('customui/'):
            raise TemplateError('Сторонние надстройки интерфейса Word не поддерживаются.')
        if active_part(name):
            if trusted.get(name) != raw:
                raise TemplateError('В документе остались неподдерживаемые компоненты макроса.')
        elif name != '_rels/.rels' and PurePosixPath(name).suffix.lower() not in PASSIVE_EXTENSIONS:
            raise TemplateError('В файле есть неподдерживаемые вложения. Используйте обычный документ Word.')
        if name.lower().endswith(('.xml', '.rels')):
            root = xml(raw)
            if name.lower().endswith('.rels'):
                ids = set()
                for node in root:
                    target = node.get('Target') or ''
                    rid = node.get('Id')
                    kind = rel_type(node)
                    if not rid or rid in ids or not target:
                        raise TemplateError('Повреждены связи частей документа.')
                    ids.add(rid)
                    if node.get('TargetMode') == 'External':
                        if kind != 'hyperlink' or urlsplit(target).scheme.lower() not in {'https', 'http', 'mailto'}:
                            raise TemplateError('Внешние вложения и подключаемые объекты не поддерживаются.')
                    else:
                        resolved = resolve_target(name, target)
                        if resolved not in files:
                            raise TemplateError('В файле отсутствует связанная часть Word.')
                        if kind in ACTIVE_RELATIONS and trusted.get(resolved) != files[resolved]:
                            raise TemplateError('Разрешён только встроенный макрос автозамены.')
                        if kind.lower() in {'oleobject', 'package', 'attachedtemplate', 'afchunk', 'subdocument'}:
                            raise TemplateError('Встроенные документы и внешние шаблоны не поддерживаются.')
            elif name.lower().startswith('word/') and not active_part(name):
                if root.xpath('//*[local-name()="altChunk" or local-name()="subDoc" or local-name()="attachedTemplate" or local-name()="OLEObject"]'):
                    raise TemplateError('Удалите встроенные объекты или внешние шаблоны.')
                if root.xpath('.//w:control|.//w:object', namespaces=NS) and (
                        not trusted or name != DOC):
                    raise TemplateError('Удалите сторонние элементы управления Word.')
                if root.xpath('.//w:ins|.//w:del|.//w:moveFrom|.//w:moveTo', namespaces=NS):
                    raise TemplateError('Примите или отклоните исправления Word перед загрузкой.')
                instructions = root.xpath('.//w:instrText/text()|.//w:fldSimple/@w:instr', namespaces=NS)
                if instructions and re.search(r'\b(?:DDEAUTO|DDE|INCLUDETEXT|INCLUDEPICTURE|LINK|IMPORT|DATABASE|MACROBUTTON)\b',
                                              ''.join(instructions), re.I):
                    raise TemplateError('Внешние поля и запуск команд в полях Word не поддерживаются.')
    content, _ = document_content_type(files)
    for node in content:
        mime = node.get('ContentType', '').lower()
        name = node.get('PartName', '').lstrip('/')
        if any(term in mime for term in ('activex', 'vbaproject', 'vbadata', 'oleobject')):
            if name not in trusted and not (node.get('Extension') == 'bin' and trusted):
                raise TemplateError('Разрешён только проверенный встроенный макрос.')
        if 'macroenabled' in mime and name != DOC:
            raise TemplateError('Встроенные документы с макросами не поддерживаются.')


def macro_parts(files):
    return {name: raw for name, raw in files.items() if active_part(name)}


def document_content_type(files):
    content = xml(files[CONTENT])
    main = [n for n in content if n.get('PartName') == '/' + DOC]
    if len(main) != 1 or main[0].get('ContentType') not in {DOCX_TYPE, DOCM_TYPE}:
        raise TemplateError('Нужен документ DOCX или DOCM.')
    return content, main[0].get('ContentType')


def discard_legacy_controls(root):
    """Discard old launch controls without touching surrounding contract text."""
    changed = False
    for control in list(root.xpath('.//w:control', namespaces=NS)):
        wrapper = next((ancestor for ancestor in control.iterancestors()
                        if ancestor.tag in {W + 'object', W + 'pict'}), control)
        if (len(wrapper.xpath('descendant-or-self::w:control', namespaces=NS)) != 1
                or wrapper.xpath('.//w:t|.//*[local-name()="OLEObject"]', namespaces=NS)):
            raise TemplateError('Старый элемент управления содержит другие данные. Удалите его в Word и повторите загрузку.')
        wrapper.getparent().remove(wrapper)
        changed = True
    return changed


def relationship_owner(name):
    if name == '_rels/.rels':
        return None
    return posixpath.join(posixpath.dirname(posixpath.dirname(name)),
                          posixpath.basename(name)[:-5])


def strip_macro_parts(files, roots):
    """Drop old VBA/ActiveX parts and their relationships without interpreting VBA."""
    discarded = {name for name in files if active_part(name)}
    for name, data in list(files.items()):
        if name in discarded or not name.lower().endswith('.rels'):
            continue
        relations = xml(data)
        removed_ids = set()
        for node in list(relations):
            if rel_type(node) not in ACTIVE_RELATIONS:
                continue
            if node.get('TargetMode') == 'External':
                raise TemplateError('Внешние компоненты макроса не поддерживаются.')
            target = resolve_target(name, node.get('Target') or '')
            if target not in discarded:
                raise TemplateError('Нестандартная структура старого макроса не поддерживается.')
            removed_ids.add(node.get('Id'))
            relations.remove(node)
        if not removed_ids:
            continue
        owner = relationship_owner(name)
        if owner in files and owner.lower().endswith('.xml'):
            owner_root = roots[owner] if owner in roots else xml(files[owner])
            if any(value in removed_ids for element in owner_root.iter()
                   for key, value in element.attrib.items() if key.startswith(R)):
                raise TemplateError('Не удалось удалить все ссылки на старый макрос.')
        files[name] = serialize(relations)
    for name in discarded:
        del files[name]


def remove_macro(files, root, *, strip_table=True, replace_legacy=False):
    """Remove the service prefix and active parts before rebuilding a template."""
    b = body(root)
    tables = service_tables(root)
    if len(tables) > 1:
        raise TemplateError('Найдено несколько таблиц автозамен.')
    if tables and strip_table:
        index = list(b).index(tables[0])
        leading = list(b)[:index]
        if any(text(el).strip() or el.tag == W + 'tbl' or (
                el.xpath('.//w:drawing|.//w:pict|.//w:object|.//w:fldChar', namespaces=NS)
                and not el.xpath('.//w:control', namespaces=NS)) for el in leading):
            raise TemplateError('Служебная таблица должна находиться в начале документа.')
        # Preserve contract body and its own section settings. The old service
        # section break is not part of the contract.
        removed_bookmarks = set()
        def remove_prefix(element):
            removed_bookmarks.update(element.xpath(
                'descendant-or-self::w:bookmarkStart/@w:id|descendant-or-self::w:bookmarkEnd/@w:id',
                namespaces=NS))
            b.remove(element)
        for element in list(b)[:index + 1]:
            remove_prefix(element)
        while len(b) and b[0].tag == W + 'p' and not text(b[0]).strip() and not b[0].xpath('.//w:drawing|.//w:pict|.//w:object|.//w:fldChar', namespaces=NS):
            remove_prefix(b[0])
        for bookmark in root.xpath('.//w:bookmarkStart|.//w:bookmarkEnd', namespaces=NS):
            if bookmark.get(W + 'id') in removed_bookmarks:
                bookmark.getparent().remove(bookmark)
    elif not strip_table:
        for element in list(b):
            if element.xpath('.//w:control', namespaces=NS):
                b.remove(element)
    roots = {DOC: root}
    if replace_legacy:
        for name in list(files):
            if name != DOC and STORY.fullmatch(name):
                roots[name] = xml(files[name])
        for name, doc in roots.items():
            if discard_legacy_controls(doc) and name != DOC:
                files[name] = serialize(doc)
    # OLE objects and unrecognized controls must never survive an upload.
    if root.xpath('.//w:control|.//w:object', namespaces=NS):
        raise TemplateError('Удалите сторонние элементы управления Word.')
    strip_macro_parts(files, roots)
    content, _ = document_content_type(files)
    for node in list(content):
        name = (node.get('PartName') or '').lstrip('/')
        if active_part(name) or node.get('Extension', '').lower() == 'bin':
            content.remove(node)
        elif name == DOC:
            node.set('ContentType', DOCX_TYPE)
    files[CONTENT] = serialize(content)
    files[DOC] = serialize(root)


def add_macro(files, button_source, table_source, *, existing_table=False):
    root = xml(files[DOC])
    b = body(root)
    donor = xml(button_source[DOC])
    buttons = [p for p in body(donor) if p.xpath('.//w:control', namespaces=NS)]
    if len(buttons) != 1:
        raise TemplateError('Не найден встроенный элемент запуска автозамены.')
    button = deepcopy(buttons[0])
    donor_rels = {r.get('Id'): r for r in xml(button_source[DOC_RELS])}
    relations = xml(files[DOC_RELS])
    content = xml(files[CONTENT])
    content_donor = xml(button_source[CONTENT])
    used = {node.get('Id') for node in relations}

    def add_relation(relation, target):
        rid = 'rIdBoykov' + str(len(used) + 1)
        while rid in used:
            rid += 'x'
        used.add(rid)
        node = deepcopy(relation)
        node.set('Id', rid)
        node.set('Target', target)
        relations.append(node)
        return rid

    def set_type(name, value):
        part = '/' + name
        node = next((n for n in content if n.get('PartName') == part), None)
        if node is None:
            node = etree.SubElement(content, CT + 'Override', PartName=part)
        node.set('ContentType', value)

    def type_of(name):
        override = next((n.get('ContentType') for n in content_donor if n.get('PartName') == '/' + name), None)
        if override:
            return override
        return next(n.get('ContentType') for n in content_donor
                    if n.get('Extension') == name.rsplit('.', 1)[-1])

    for name, data in macro_parts(button_source).items():
        if name in files:
            raise TemplateError('Конфликт встроенных частей макроса.')
        files[name] = data
        if not name.endswith('.rels'):
            set_type(name, type_of(name))
    for relation in donor_rels.values():
        if rel_type(relation) == 'vbaProject':
            add_relation(relation, relation.get('Target'))
    mapped = {}
    for element in button.iter():
        for key, value in list(element.attrib.items()):
            if not key.startswith(R):
                continue
            if value not in mapped:
                relation = donor_rels[value]
                target = relation.get('Target')
                if rel_type(relation) == 'image':
                    original = resolve_target(DOC_RELS, target)
                    suffix = PurePosixPath(original).suffix
                    image = 'word/media/boykov-template-button' + suffix
                    while image in files and files[image] != button_source[original]:
                        image = image[:-len(suffix)] + '-copy' + suffix
                    files[image] = button_source[original]
                    set_type(image, type_of(original))
                    target = image.removeprefix('word/')
                elif rel_type(relation) != 'control':
                    raise TemplateError('Неизвестная часть встроенной кнопки.')
                mapped[value] = add_relation(relation, target)
            element.set(key, mapped[value])
        for attribute in list(element.attrib):
            if etree.QName(attribute).localname in {'paraId', 'textId'}:
                del element.attrib[attribute]
    # Keep the control's shape references consistent without colliding with
    # the imported document's existing pictures.
    shape_ids = button.xpath('.//w:control/@w:shapeid', namespaces=NS)
    if shape_ids:
        used_ids = {v for e in root.iter() for v in e.attrib.values()}
        new_shape_id = shape_ids[0]
        while new_shape_id in used_ids:
            new_shape_id = '_x0000_i' + str(int(new_shape_id.rsplit('i', 1)[1]) + 1)
        for element in button.iter():
            for key, value in list(element.attrib.items()):
                if value == shape_ids[0]:
                    element.set(key, new_shape_id)
    b.insert(0, button)
    if not existing_table:
        table = deepcopy(service_tables(xml(table_source[DOC]))[0])
        # Directly formatted Word table; remove style IDs specific to the
        # original document and unwrap data-entry content controls.
        for node in table.xpath('.//w:pStyle|.//w:rStyle|.//w:tblStyle', namespaces=NS):
            node.getparent().remove(node)
        for node in reversed(table.xpath('.//w:sdt', namespaces=NS)):
            payload = node.find(W + 'sdtContent')
            if payload is not None:
                parent = node.getparent()
                for child in list(payload):
                    parent.insert(parent.index(node), child)
                parent.remove(node)
        for element in table.iter():
            for attribute in list(element.attrib):
                if etree.QName(attribute).localname in {'paraId', 'textId'}:
                    del element.attrib[attribute]
        b.insert(1, table)
        paragraph = etree.Element(W + 'p')
        run = etree.SubElement(paragraph, W + 'r')
        etree.SubElement(run, W + 'br', {W + 'type': 'page'})
        b.insert(2, paragraph)
    set_type(DOC, DOCM_TYPE)
    files[DOC] = serialize(root)
    files[DOC_RELS] = serialize(relations)
    files[CONTENT] = serialize(content)


def paragraphs(files):
    """Stable text blocks within a revision, excluding the protected table."""
    for name in sorted((n for n in files if STORY.fullmatch(n)), key=lambda n: (n != DOC, n)):
        root = xml(files[name])
        tables = service_tables(root) if name == DOC else []
        for index, p in enumerate(root.xpath('.//w:p', namespaces=NS)):
            value = text(p)
            if not value.strip() or any(t in p.iterancestors() for t in tables):
                continue
            if p.xpath('.//w:control', namespaces=NS):
                continue
            locked = bool(p.xpath('.//w:fldChar|.//w:instrText|.//w:fldSimple|.//w:drawing|.//w:pict|.//w:object|.//w:hyperlink|.//w:tab|.//w:br|.//w:txbxContent', namespaces=NS)
                          or p.xpath('.//w:sdt', namespaces=NS)
                          or any(a.tag in {W + 'txbxContent', W + 'del', W + 'ins', W + 'sdt'} for a in p.iterancestors())
                          or len(value) > 8000)
            yield name, root, p, {
                'id': f'{name}#{index}', 'text': value, 'editable': not locked,
                'location': ('Ячейка таблицы' if any(a.tag == W + 'tc' for a in p.iterancestors())
                             else 'Текст договора') if name == DOC else (
                                 'Колонтитул' if 'header' in name or 'footer' in name else 'Сноска'),
                'fieldsAllowed': name == DOC and not locked,
            }


def replace_text(p, value):
    """Keep unchanged character runs and styles; new text inherits the run
    at the edit position. Paragraph and table formatting never get rebuilt."""
    nodes = p.xpath('.//w:t', namespaces=NS)
    old = ''.join(n.text or '' for n in nodes)
    if old == value:
        return
    if not nodes:
        raise TemplateError('В этом абзаце нельзя изменить текст.')
    owners = []
    for index, node in enumerate(nodes):
        owners.extend([index] * len(node.text or ''))
    parts = [[] for _ in nodes]
    for opcode, a, b, c, d in SequenceMatcher(None, old, value).get_opcodes():
        if opcode == 'equal':
            for at, char in enumerate(value[c:d], a):
                parts[owners[at]].append(char)
        elif opcode in {'insert', 'replace'}:
            owner = owners[a] if a < len(owners) else owners[-1]
            parts[owner].append(value[c:d])
    for node, chunks in zip(nodes, parts):
        node.text = ''.join(chunks)
        if node.text.startswith(' ') or node.text.endswith(' '):
            node.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')


class TemplateDocuments:
    def __init__(self, directory: Path | None = None, originals=None):
        self.originals = {key: unpack(originals[key] if originals is not None else
                                      (directory / name).read_bytes()) for key, name in FILES.items()}
        self.donors = {key: self.originals['passport_security' if key == 'passport_security_agreed' else key] for key in FILES}
        self.fields = {}
        for key, files in self.originals.items():
            root = xml(files[DOC])
            table = service_tables(root)[0]
            required = set()
            for p in root.xpath('.//w:body//w:p', namespaces=NS):
                if table not in p.iterancestors():
                    required.update(TAG.findall(text(p)))
            self.fields[key] = [dict(field, required=field['key'] in required)
                                for field in table_fields(table)]

    def initial(self, key):
        files = self.originals[key].copy()
        if key == 'passport_security_agreed':
            # This legacy template had ReplaceTags but no launch button.
            # The already used generic ReplaceTags macro reads the first
            # five-column table, independently of the number of fields.
            remove_macro(files, xml(files[DOC]), strip_table=False)
            add_macro(files, self.donors[key], self.originals[key], existing_table=True)
        return pack(files)

    def prepare(self, key, raw, suffix):
        files = unpack(raw)
        _, kind = document_content_type(files)
        replace_legacy = suffix == '.docm' and kind == DOCM_TYPE
        if not replace_legacy:
            check_package(files)
        root = xml(files[DOC])
        tables = service_tables(root)
        if tables and table_fields(tables[0]) != table_fields(service_tables(xml(self.originals[key][DOC]))[0]):
            raise TemplateError('Таблица автозамен не соответствует выбранному типу договора.')
        # The uploaded project is never trusted, even temporarily. Validate
        # the passive remainder, then attach only the stored donor bundle.
        remove_macro(files, root, replace_legacy=replace_legacy)
        check_package(files)
        add_macro(files, self.donors[key], self.originals[key])
        check_package(files, trusted=macro_parts(self.donors[key]))
        raw = pack(files)
        self.inspect(key, raw)
        return raw

    def clean(self, key, raw):
        files = unpack(raw)
        remove_macro(files, xml(files[DOC]))
        return pack(files)

    def inspect(self, key, raw):
        files = unpack(raw)
        root = xml(files[DOC])
        tables = service_tables(root)
        if len(tables) != 1 or table_fields(tables[0]) != [
                {k: f[k] for k in ('key', 'label')} for f in self.fields[key]]:
            raise TemplateError('Нарушена защищённая таблица автозамен.')
        if body(root).find(W + 'tbl') is not tables[0]:
            raise TemplateError('Таблица автозамен должна быть первой.')
        if macro_parts(files) != macro_parts(self.donors[key]) or len(root.xpath('.//w:control[@w:name="CommandButton1"]', namespaces=NS)) != 1:
            raise TemplateError('Нарушена структура встроенного макроса или кнопки.')
        blocks = [block for _, _, _, block in paragraphs(files)]
        if not blocks or len(blocks) > 4000:
            raise TemplateError('В шаблоне нет текста или слишком много абзацев.')
        present = set()
        problems = []
        misplaced = set()
        for block in blocks:
            tags = set(TAG.findall(block['text']))
            if block['id'].startswith(DOC + '#'):
                present.update(tags)
                present.update(INVALID_TAG.findall(block['text']))
            else:
                misplaced.update(tags)
        allowed = {f['key'] for f in self.fields[key]}
        missing = [f['key'] for f in self.fields[key] if f['required'] and f['key'] not in present]
        unexpected = sorted(present - allowed)
        if missing:
            problems.append('Не подключены обязательные поля: ' + ', '.join(missing))
        if unexpected:
            problems.append('Неизвестные поля: ' + ', '.join(unexpected))
        if misplaced:
            problems.append('Поля автозамены должны находиться в основном тексте: ' + ', '.join(sorted(misplaced)))
        if key == 'sout':
            for k in ('autozamena_004', 'autozamena_008'):
                if sum(block['text'].count(k) for block in blocks) < 2:
                    problems.append(f'Поле {k} требуется в обоих блоках реквизитов.')
        if key == 'ser_one_time':
            specs = [t for t in body(root).findall(W + 'tbl') if 'Перечень оказываемых услуг' in text(t)]
            if len(specs) != 1 or len(specs[0].findall(W + 'tr')) != 10 or any(
                    len(cells(row)) != 7 for row in specs[0].findall(W + 'tr')):
                problems.append('В приложении №1 нужна таблица услуг: 7 колонок и 9 строк для заполнения.')
        return {'blocks': blocks, 'fields': [dict(f, present=f['key'] in present) for f in self.fields[key]],
                'problems': problems}

    def edit(self, key, raw, changes):
        files = unpack(raw)
        pending = dict(changes)
        if len(pending) != len(changes):
            raise TemplateError('Повторяющееся изменение абзаца.')
        modified = {}
        for name, root, node, block in paragraphs(files):
            if block['id'] not in pending:
                continue
            value = pending.pop(block['id'])
            if not block['editable'] or not isinstance(value, str) or len(value) > 8000 or re.search(r'[\x00-\x1f]', value):
                raise TemplateError('Этот абзац нельзя изменить таким способом.')
            replace_text(node, value)
            modified[name] = root
        if pending:
            raise TemplateError('Изменяемый абзац не найден. Откройте шаблон заново.')
        for name, root in modified.items():
            files[name] = serialize(root)
        updated = pack(files) if modified else raw
        info = self.inspect(key, updated)
        if info['problems']:
            raise TemplateError('; '.join(info['problems']))
        return updated
