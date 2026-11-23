"""Read-only Word layout projection. Never open Office or execute document code.

The browser receives typed text, style, table and bounded raster data, not HTML.
Paragraph IDs match the existing editor and refer to the original XML.
"""
from base64 import b64encode
from io import BytesIO
import re
from warnings import catch_warnings, simplefilter

from PIL import Image
from lxml import etree

from .template_documents import (DOC, W, R, NS, STORY, body, xml,
                                 service_tables, resolve_target, text)


class LayoutLimit(Exception):
    pass


def attr(node, name='val', default=None):
    return node.get(W + name, default) if node is not None else default


def child(node, name):
    return node.find(W + name) if node is not None else None


def number(value, default=0, low=0, high=50000):
    try:
        return max(low, min(high, int(value)))
    except (ValueError, TypeError, OverflowError):
        return default


def points(value, default=0, low=0, high=2000):
    return number(value, round(default * 20), round(low * 20), round(high * 20)) / 20


def enabled(node):
    return attr(node, default='1') not in ('0', 'false', 'off', 'none')


def rgb(value):
    return '#' + value if value and re.fullmatch(r'[0-9a-fA-F]{6}', value) else None


def border_style(node):
    if node is None:
        return None
    kind = attr(node)
    if kind in ('nil', 'none'):
        return 'none'
    style = {'double': 'double', 'dotted': 'dotted', 'dashed': 'dashed', 'dashSmallGap': 'dashed'}.get(kind, 'solid')
    size = number(attr(node, 'sz'), 4, 1, 24) / 8
    return f'{size}pt {style} {rgb(attr(node, "color")) or "#333333"}'


def run_style(props):
    if props is None:
        return {}
    result = {}
    fonts = child(props, 'rFonts')
    font = attr(fonts, 'hAnsi') or attr(fonts, 'ascii')
    if font and len(font) <= 70 and re.fullmatch(r'[\w .-]+', font):
        result['fontFamily'] = font
    size = attr(child(props, 'sz'))
    if size is not None:
        result['fontSize'] = number(size, 24, 12, 144) / 2
    for source, dest in [('b', 'bold'), ('i', 'italic'), ('u', 'underline'), ('strike', 'strike')]:
        node = child(props, source)
        if node is not None:
            result[dest] = enabled(node)
    color = rgb(attr(child(props, 'color')))
    if color:
        result['color'] = color
    return result


def paragraph_style(props):
    if props is None:
        return {}
    result = {}
    align = attr(child(props, 'jc'))
    if align in ('left', 'start', 'center', 'right', 'end', 'both', 'distribute'):
        result['align'] = {'both': 'justify', 'distribute': 'justify', 'start': 'left', 'end': 'right'}.get(align, align)
    spacing = child(props, 'spacing')
    for key in ('before', 'after'):
        if attr(spacing, key) is not None:
            result[key] = points(attr(spacing, key), high=144)
    line = attr(spacing, 'line')
    if line is not None:
        if attr(spacing, 'lineRule', 'auto') == 'auto':
            result['lineHeight'] = number(line, 240, 120, 720) / 240
        else:
            result['linePoints'] = points(line, 12, 6, 144)
    indent = child(props, 'ind')
    for key in ('left', 'right', 'firstLine'):
        value = attr(indent, key)
        if value is not None:
            result[key] = points(value, low=-144, high=400)
    if attr(indent, 'hanging') is not None:
        result['firstLine'] = -points(attr(indent, 'hanging'), high=144)
    return result


class Layout:
    def __init__(self, files, blocks):
        self.files = files
        self.blocks = {b['id']: b for b in blocks}
        self.styles = {}
        self.defaults = {'fontFamily': 'Times New Roman', 'fontSize': 12}
        self.default_p = {'align': 'left', 'lineHeight': 1.15, 'after': 0}
        if 'word/styles.xml' in files:
            root = xml(files['word/styles.xml'])
            self.styles = {attr(s, 'styleId'): s for s in root.findall(W + 'style')}
            defaults = child(root, 'docDefaults')
            self.defaults.update(run_style(child(child(defaults, 'rPrDefault'), 'rPr')))
            self.default_p.update(paragraph_style(child(child(defaults, 'pPrDefault'), 'pPr')))
        self.default_style = next((key for key, style in self.styles.items()
                                   if attr(style, 'type') == 'paragraph' and attr(style, 'default') == '1'), None)
        self.images = {}
        self.unavailable_images = set()
        self.image_budget = 1500000
        self.element_budget = 25000
        self.run_budget = 60000
        self.text_budget = 2000000
        self.relations = {}
        self.numbering = {}
        self.number_counts = {}
        if 'word/numbering.xml' in files:
            root = xml(files['word/numbering.xml'])
            abstract = {attr(n, 'abstractNumId'): n for n in root.findall(W + 'abstractNum')}
            self.numbering = {attr(n, 'numId'): abstract.get(attr(child(n, 'abstractNumId')))
                              for n in root.findall(W + 'num')}

    def style_chain(self, key):
        chain, seen = [], set()
        while key in self.styles and key not in seen and len(chain) < 32:
            seen.add(key)
            item = self.styles[key]
            chain.append(item)
            key = attr(child(item, 'basedOn'))
        return reversed(chain)

    def styles_for(self, p):
        props = child(p, 'pPr')
        base = self.defaults.copy()
        layout = self.default_p.copy()
        for item in self.style_chain(attr(child(props, 'pStyle')) or self.default_style):
            base.update(run_style(child(item, 'rPr')))
            layout.update(paragraph_style(child(item, 'pPr')))
        layout.update(paragraph_style(props))
        base.update(run_style(child(props, 'rPr')))
        return base, layout

    def list_label(self, p):
        num = child(child(p, 'pPr'), 'numPr')
        num_id = attr(child(num, 'numId'))
        level = number(attr(child(num, 'ilvl')), high=8)
        scheme = self.numbering.get(num_id)
        if scheme is None:
            return ''
        lvl = next((n for n in scheme.findall(W + 'lvl') if attr(n, 'ilvl') == str(level)), None)
        if lvl is None:
            return ''
        if attr(child(lvl, 'numFmt')) == 'bullet':
            return '•'
        counts = self.number_counts.setdefault(num_id, {})
        counts[level] = counts.get(level, number(attr(child(lvl, 'start')), 1) - 1) + 1
        for ix in list(counts):
            if ix > level:
                del counts[ix]
        pattern = attr(child(lvl, 'lvlText'), default='%1.')
        return re.sub(r'%([1-9])', lambda m: str(counts.get(int(m[1]) - 1, 1)), pattern)[:40]

    def rels(self, name):
        if name not in self.relations:
            folder, filename = name.rsplit('/', 1)
            rel_path = folder + '/_rels/' + filename + '.rels'
            relations = {}
            if rel_path in self.files:
                for r in xml(self.files[rel_path]):
                    if r.get('TargetMode') != 'External' and r.get('Target'):
                        relations[r.get('Id')] = resolve_target(rel_path, r.get('Target'))
            self.relations[name] = relations
        return self.relations[name]

    def image(self, name, node):
        refs = node.xpath('.//*[local-name()="blip" or local-name()="imagedata"]')
        ref = next((n.get(R + 'embed') or n.get(R + 'id') for n in refs), None)
        path = self.rels(name).get(ref)
        if not path or not path.startswith('word/media/') or path in self.unavailable_images:
            return None
        if path not in self.images:
            # Do not repeatedly decode a missing or unsupported image.
            self.unavailable_images.add(path)
            raw = self.files.get(path, b'')
            if len(raw) > 8 * 1024 * 1024 or len(self.images) >= 30 or self.image_budget <= 0:
                return None
            try:
                with catch_warnings():
                    simplefilter('error', Image.DecompressionBombWarning)
                    with Image.open(BytesIO(raw)) as img:
                        if img.format not in ('PNG', 'JPEG', 'GIF', 'BMP', 'TIFF') or img.width * img.height > 8000000:
                            return None
                        img.thumbnail((1200, 1200))
                        stream = BytesIO()
                        img.convert('RGBA').save(stream, 'PNG')
                        payload = stream.getvalue()
                        if len(payload) > self.image_budget:
                            return None
                        self.image_budget -= len(payload)
                        self.images[path] = {'src': 'data:image/png;base64,' + b64encode(payload).decode('ascii'),
                                             'width': img.width, 'height': img.height}
                        self.unavailable_images.discard(path)
            except (OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
                return None
        picture = self.images[path]
        extent = next(iter(node.xpath('.//*[local-name()="extent"]')), None)
        width = number(extent.get('cx') if extent is not None else None, 0, 0, 10000000) / 12700
        return {'image': path, 'width': width or min(300, picture['width'] * .75)}

    def paragraph(self, name, p, ids):
        self.element_budget -= 1
        if self.element_budget < 0:
            raise LayoutLimit()
        base, layout = self.styles_for(p)
        runs = []
        for r in p.xpath('.//w:r', namespaces=NS):
            # Text boxes are separate unsupported drawings, not duplicate runs.
            if next((a for a in r.iterancestors() if a.tag == W + 'p'), None) is not p:
                continue
            self.run_budget -= 1
            if self.run_budget < 0:
                raise LayoutLimit()
            props = child(r, 'rPr')
            style = base.copy()
            for item in self.style_chain(attr(child(props, 'rStyle'))):
                style.update(run_style(child(item, 'rPr')))
            style.update(run_style(props))
            for item in r:
                local = etree.QName(item).localname
                if local == 't' and item.text:
                    self.text_budget -= len(item.text)
                    if self.text_budget < 0:
                        raise LayoutLimit()
                    runs.append({'text': item.text, 'style': style})
                elif local in ('tab', 'br', 'cr') and attr(item, 'type') != 'page':
                    runs.append({'text': '\t' if local == 'tab' else '\n', 'style': style})
                elif local in ('drawing', 'pict'):
                    runs.append(self.image(name, item) or {'text': '[Изображение Word]', 'style': style})
        block_id = ids.get(p)
        marker = self.list_label(p)
        return {'kind': 'paragraph', 'id': block_id, 'style': layout, 'base': base,
                'runs': runs, 'label': marker, 'breakBefore': bool(
                    child(child(p, 'pPr'), 'pageBreakBefore') is not None or
                    p.xpath('.//w:lastRenderedPageBreak', namespaces=NS)),
                'breakAfter': bool(p.xpath('.//w:br[@w:type="page"]', namespaces=NS))}

    def table(self, name, table, ids):
        grid = child(table, 'tblGrid')
        widths = [number(attr(col, 'w'), 1000, 1) for col in grid] if grid is not None else []
        rows, vertical = [], {}
        props = child(table, 'tblPr')
        borders = {}
        for style in self.style_chain(attr(child(props, 'tblStyle'))):
            inherited = child(child(style, 'tblPr'), 'tblBorders')
            if inherited is not None:
                borders.update({etree.QName(n).localname: border_style(n) for n in inherited})
        direct = child(props, 'tblBorders')
        if direct is not None:
            borders.update({etree.QName(n).localname: border_style(n) for n in direct})
        source_rows = table.findall(W + 'tr')
        for row_index, row in enumerate(source_rows):
            row_props = child(row, 'trPr')
            before = number(attr(child(row_props, 'gridBefore')), high=40)
            after = number(attr(child(row_props, 'gridAfter')), high=40)
            result, following, column = [], {}, before
            if before:
                result.append({'colSpan': before, 'rowSpan': 1, 'nodes': [], 'spacer': True})
            for tc in row.xpath('./w:tc|./w:sdt/w:sdtContent/w:tc', namespaces=NS):
                self.element_budget -= 1
                if self.element_budget < 0:
                    raise LayoutLimit()
                props = child(tc, 'tcPr')
                span = number(attr(child(props, 'gridSpan')), 1, 1, 50)
                merge = child(props, 'vMerge')
                continuation = merge is not None and attr(merge, default='continue') != 'restart'
                cell_borders = child(props, 'tcBorders')
                lines = {}
                for side, inherited in [('top', 'top' if row_index == 0 else 'insideH'),
                                        ('bottom', 'bottom' if row_index == len(source_rows) - 1 else 'insideH'),
                                        ('left', 'left' if column == 0 else 'insideV'),
                                        ('right', 'right' if column + span >= len(widths) else 'insideV')]:
                    lines[side] = border_style(child(cell_borders, side)) or borders.get(inherited) or 'none'
                if continuation and column in vertical and not text(tc).strip():
                    previous = vertical[column]
                    previous['rowSpan'] += 1
                    previous['borders']['bottom'] = lines['bottom']
                    following[column] = previous
                else:
                    cell = {'colSpan': span, 'rowSpan': 1, 'nodes': self.nodes(name, tc, ids), 'borders': lines}
                    fill = rgb(attr(child(props, 'shd'), 'fill'))
                    if fill:
                        cell['fill'] = fill
                    result.append(cell)
                    if merge is not None:
                        following[column] = cell
                column += span
            if after:
                result.append({'colSpan': after, 'rowSpan': 1, 'nodes': [], 'spacer': True})
            vertical = following
            rows.append(result)
        # Split large tables only between independent row groups so vertical
        # merges never cross an artificial browser page boundary.
        groups, group, end = [], [], 0
        for index, row in enumerate(rows):
            group.append(row)
            end = max([end] + [index + c['rowSpan'] for c in row])
            if index + 1 >= end and len(group) >= 12:
                groups.append(group)
                group = []
        if group:
            groups.append(group)
        return [{'kind': 'table', 'widths': widths, 'rows': group, 'border': bool(borders)} for group in groups]

    def nodes(self, name, parent, ids):
        result = []
        for node in parent:
            if node.tag == W + 'p':
                result.append(self.paragraph(name, node, ids))
            elif node.tag == W + 'tbl':
                result.extend(self.table(name, node, ids))
            elif node.tag == W + 'sdt':
                content = child(node, 'sdtContent')
                if content is not None:
                    result.extend(self.nodes(name, content, ids))
        return result

    def dimensions(self, props):
        size = child(props, 'pgSz')
        margin = child(props, 'pgMar')
        width = points(attr(size, 'w'), 595, 240, 1200)
        height = points(attr(size, 'h'), 842, 240, 1600)
        return {'width': width, 'height': height,
                **{side: points(attr(margin, side), 42, 0, min(width, height) / 3)
                   for side in ('top', 'right', 'bottom', 'left')}}

    def build(self):
        root = xml(self.files[DOC])
        ids = {p: f'{DOC}#{index}' for index, p in enumerate(root.xpath('.//w:p', namespaces=NS))}
        content = body(root)
        table = service_tables(root)[0]
        remaining = list(content)[list(content).index(table) + 1:]
        # The separator after the protected macro table is not contract text.
        while remaining and remaining[0].tag == W + 'p' and not text(remaining[0]).strip() and not remaining[0].xpath('.//w:drawing|.//w:pict', namespaces=NS):
            remaining.pop(0)
        sections, nodes = [], []
        for node in remaining:
            if node.tag == W + 'sectPr':
                if nodes:
                    sections.append({'paper': self.dimensions(node), 'nodes': nodes})
                    nodes = []
                continue
            if node.tag == W + 'p':
                nodes.append(self.paragraph(DOC, node, ids))
                props = child(child(node, 'pPr'), 'sectPr')
                if props is not None:
                    sections.append({'paper': self.dimensions(props), 'nodes': nodes})
                    nodes = []
            elif node.tag == W + 'tbl':
                nodes.extend(self.table(DOC, node, ids))
            elif node.tag == W + 'sdt':
                nested = child(node, 'sdtContent')
                if nested is not None:
                    nodes.extend(self.nodes(DOC, nested, ids))
        if nodes:
            sections.append({'paper': self.dimensions(child(content, 'sectPr')), 'nodes': nodes})
        extras = []
        for name in sorted(self.files):
            if name == DOC or not STORY.fullmatch(name):
                continue
            story = xml(self.files[name])
            ids = {p: f'{name}#{index}' for index, p in enumerate(story.xpath('.//w:p', namespaces=NS))}
            nodes = self.nodes(name, story, ids)
            if 'notes' in name:
                nodes = [n for note in story for n in self.nodes(name, note, ids)]
            if any(i in self.blocks for i in ids.values()) or any(n.get('runs') for n in nodes):
                label = 'Верхний колонтитул' if 'header' in name else 'Нижний колонтитул' if 'footer' in name else 'Сноски'
                extras.append({'label': label, 'nodes': nodes})
        def visible(nodes):
            for node in nodes:
                if node['kind'] == 'paragraph':
                    yield node['id']
                else:
                    for row in node['rows']:
                        for cell in row:
                            yield from visible(cell['nodes'])
        shown = {i for group in sections + extras for i in visible(group['nodes'])}
        omitted = [b for b in self.blocks.values() if b['id'] not in shown]
        if omitted:
            extras.append({'label': 'Другие элементы Word', 'nodes': [
                {'kind': 'paragraph', 'id': b['id'], 'style': self.default_p,
                 'base': self.defaults, 'runs': [{'text': b['text'], 'style': self.defaults}],
                 'label': '', 'breakBefore': False, 'breakAfter': False} for b in omitted]})
        return {'sections': sections, 'extras': extras, 'images': self.images}


def build_layout(files, blocks):
    try:
        return Layout(files, blocks).build()
    except LayoutLimit:
        return {'sections': [], 'extras': [], 'images': {},
                'warning': 'Документ слишком сложный для визуального редактора. Скачайте DOCX для правок в Word.'}
