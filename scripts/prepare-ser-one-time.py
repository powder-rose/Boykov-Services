"""Add the existing, manually launched macro button to a 20-field DOCM.

Usage: python scripts/prepare-ser-one-time.py SOURCE.docm [DESTINATION.docm]
The contract wording and existing 20 replacement tags are preserved.
"""
from copy import deepcopy
from pathlib import Path
import re
import sys
from zipfile import ZipFile, ZIP_DEFLATED

from lxml import etree

ROOT = Path(__file__).resolve().parent.parent
CORE = ROOT / 'worker/vendor/core'
WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ns = {'w': WORD, 'r': REL}


def prepare(source_path: Path, destination: Path | None = None) -> Path:
    destination = destination or CORE / 'ООО СПЕЦЭНЕРГОРАЗВИТИЕ_РАЗОВЫЕ.docm'
    with ZipFile(source_path) as source, ZipFile(CORE / 'template2.docm') as donor:
        files = {member.filename: (member, source.read(member)) for member in source.infolist()}
        document = etree.fromstring(source.read('word/document.xml'))
        donor_document = etree.fromstring(donor.read('word/document.xml'))
        button = deepcopy(donor_document.xpath('./w:body/w:p[.//w:control]', namespaces=ns)[0])
        for mark in button.xpath('.//w:bookmarkStart | .//w:bookmarkEnd', namespaces=ns):
            mark.getparent().remove(mark)
        for attribute in list(button.attrib):
            del button.attrib[attribute]
        ids = document.xpath('//@id')
        shape_number = max([1024] + [int(match.group(1)) for value in ids if (match := re.fullmatch(r'_x0000_i(\d+)', value))]) + 1
        for shape in button.xpath('.//*[@id]'):
            if shape.get('id', '').startswith('_x0000_i'):
                shape.set('id', f'_x0000_i{shape_number}')
        button.xpath('.//w:control', namespaces=ns)[0].set(f'{{{WORD}}}shapeid', f'_x0000_i{shape_number}')
        relationships = etree.fromstring(source.read('word/_rels/document.xml.rels'))
        donor_relationships = etree.fromstring(donor.read('word/_rels/document.xml.rels'))
        next_id = max(int(node.get('Id')[3:]) for node in relationships) + 1
        for original_id in sorted(set(button.xpath('.//@r:id', namespaces=ns))):
            relation = next(node for node in donor_relationships if node.get('Id') == original_id)
            relation = deepcopy(relation)
            new_id = f'rId{next_id}'
            next_id += 1
            relation.set('Id', new_id)
            target = relation.get('Target')
            if relation.get('Type').endswith('/image'):
                files['word/media/ser-macro-button.wmf'] = (donor.getinfo('word/' + target), donor.read('word/' + target))
                relation.set('Target', 'media/ser-macro-button.wmf')
            elif not relation.get('Type').endswith('/control'):
                raise ValueError('Unexpected relationship on the macro button')
            relationships.append(relation)
            for node in button.xpath('.//*[@r:id]', namespaces=ns):
                if node.get(f'{{{REL}}}id') == original_id:
                    node.set(f'{{{REL}}}id', new_id)
        for member in donor.infolist():
            if member.filename.startswith('word/activeX/') or member.filename in {
                'word/vbaProject.bin', 'word/_rels/vbaProject.bin.rels', 'word/vbaData.xml',
            }:
                files[member.filename] = (member, donor.read(member))
        types = etree.fromstring(source.read('[Content_Types].xml'))
        donor_types = etree.fromstring(donor.read('[Content_Types].xml'))
        for node in donor_types:
            if node.get('PartName', '').startswith('/word/activeX/') or node.get('Extension') == 'wmf':
                if not any(existing.attrib == node.attrib for existing in types):
                    types.append(deepcopy(node))
        body = document.find('w:body', ns)
        body.insert(0, button)
        # The added button must not split a replacement-field row across pages.
        for row in body.find('w:tbl', ns).findall('w:tr', ns):
            properties = row.find('w:trPr', ns)
            if properties is None:
                properties = etree.Element(f'{{{WORD}}}trPr')
                row.insert(0, properties)
            if properties.find('w:cantSplit', ns) is None:
                etree.SubElement(properties, f'{{{WORD}}}cantSplit')
        for name, tree in {
            'word/document.xml': document,
            'word/_rels/document.xml.rels': relationships,
            '[Content_Types].xml': types,
        }.items():
            member = files[name][0]
            files[name] = (member, etree.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True))
        text = ''.join(document.xpath('.//w:t/text()', namespaces=ns))
        if set(re.findall(r'autozamena_\d{3}', text)) != {f'autozamena_{index:03d}' for index in range(1, 21)}:
            raise ValueError('Expected the original 20 replacement tags')
        with ZipFile(destination, 'w', ZIP_DEFLATED) as output:
            for name, (member, data) in files.items():
                member = deepcopy(member)
                member.filename = name
                output.writestr(member, data)
    return destination


if __name__ == '__main__':
    print(prepare(Path(sys.argv[1]), Path(sys.argv[2]) if len(sys.argv) > 2 else None))
