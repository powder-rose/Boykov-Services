"""Fill the service rows in appendix 1 without changing the DOCM macros."""
from copy import deepcopy
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

from lxml import etree

from .vendor.core.misc import Miscellaneous


def fill_service_specification(path: Path, services: list[dict]) -> None:
    ns = {'w': Miscellaneous.WORD_NS}
    with ZipFile(path) as source:
        root = etree.fromstring(source.read('word/document.xml'))
        tables = root.xpath(
            './w:body/w:tbl[contains(string(.), "Перечень оказываемых услуг")]',
            namespaces=ns,
        )
        if len(tables) != 1:
            raise RuntimeError('В шаблоне не найдено приложение №1 с перечнем услуг')
        table = tables[0]
        rows = table.findall('w:tr', ns)
        if not 1 <= len(services) <= len(rows) - 1:
            raise ValueError('Для приложения №1 нужно от 1 до 9 услуг')
        for row, item in zip(rows[1:], services):
            cells = []
            for node in list(row):
                if etree.QName(node).localname == 'tc':
                    cells.append(node)
                elif etree.QName(node).localname == 'sdt':
                    cell = node.find('./w:sdtContent/w:tc', ns)
                    if cell is None:
                        raise RuntimeError('Повреждено поле услуги в приложении №1')
                    cell = deepcopy(cell)
                    row.replace(node, cell)
                    cells.append(cell)
            if len(cells) != 7:
                raise RuntimeError('В приложении №1 должно быть 7 колонок')
            values = {
                1: item['name'],
                2: str(item['working_days']),
                3: str(item['quantity']),
                5: str(item['price']),
                6: str(item['quantity'] * item['price']),
            }
            for index, value in values.items():
                Miscellaneous._set_replacement_cell_value(cells[index], value, ns)
        for row in rows[len(services) + 1:]:
            table.remove(row)
        updated = etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
        temporary = path.with_name(path.name + '.tmp')
        try:
            with ZipFile(temporary, 'w', ZIP_DEFLATED) as result:
                for member in source.infolist():
                    result.writestr(member, updated if member.filename == 'word/document.xml' else source.read(member))
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.replace(path)
