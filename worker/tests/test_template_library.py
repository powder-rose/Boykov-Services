import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from zipfile import ZipFile

from docx import Document
from lxml import etree

from worker.template_documents import (DOC, NS, FILES, W, TemplateError,
    TemplateDocuments, unpack, pack, xml, text, service_tables, macro_parts,
    check_package)
from worker.template_library import TemplateLibrary, TemplateConflict

ROOT = Path(__file__).resolve().parents[2]
CATALOG = json.loads((ROOT / 'shared/templates.json').read_text(encoding='utf-8'))
ORIGINALS = ROOT / 'worker/vendor/core'
OWNER = str(uuid4())


class TemplateLibraryTests(unittest.TestCase):
    def setUp(self):
        self.workspace = TemporaryDirectory(prefix='boykov-template-test-')
        self.addCleanup(self.workspace.cleanup)
        self.directory = Path(self.workspace.name)
        self.library = TemplateLibrary(self.directory, ORIGINALS, CATALOG)

    def test_roundtrip_all_six_preserves_content_and_trusted_macros(self):
        for key in FILES:
            with self.subTest(key=key):
                meta, raw = self.library.snapshot(key)
                self.assertEqual(meta['version'], 1)
                clean = self.library.documents.clean(key, raw)
                clean_files = unpack(clean)
                self.assertFalse(macro_parts(clean_files))
                self.assertFalse(service_tables(xml(clean_files[DOC])))
                Document(io.BytesIO(clean))
                for suffix, uploaded in [('.docx', clean), ('.docm', raw)]:
                    prepared = self.library.documents.prepare(key, uploaded, suffix)
                    output = unpack(prepared)
                    self.assertEqual(macro_parts(output), macro_parts(unpack(raw)))
                    check_package(output, trusted=macro_parts(output))
                    self.assertFalse(self.library.documents.inspect(key, prepared)['problems'])
                    root = xml(output[DOC])
                    self.assertEqual(1, len(root.xpath('.//w:control[@w:name="CommandButton1"]', namespaces=NS)))
                    self.assertIs(root.find(W+'body').find(W+'tbl'), service_tables(root)[0])
                    new_clean = unpack(self.library.documents.clean(key, prepared))
                    for name in clean_files:
                        if name.startswith('word/') and name not in (DOC, 'word/_rels/document.xml.rels'):
                            self.assertEqual(clean_files[name], new_clean[name], name)
                    self.assertEqual(text(xml(clean_files[DOC])), text(xml(new_clean[DOC])))

    def test_publish_edit_uses_persistent_version_and_restores_without_overwrite(self):
        key = 'specons'
        first, original = self.library.snapshot(key)
        data = self.library.editor(key, OWNER)
        block = next(b for b in data['blocks'] if b['editable'] and len(b['text']) > 150 and 'autozamena' not in b['text'])
        change = [(block['id'], block['text'] + ' Уточнённое условие договора.')]
        result = self.library.publish(key, 1, OWNER, 'Анна', 'Правка условия', change)
        self.assertEqual(result['active']['version'], 2)
        second, updated = self.library.snapshot(key)
        self.assertEqual(second['author'], 'Анна')
        self.assertEqual(second['source'], 'edit')
        self.assertIn('Уточнённое условие договора.', text(xml(unpack(updated)[DOC])))
        for name, content in unpack(original).items():
            if name != DOC:
                self.assertEqual(content, unpack(updated)[name])
        before = xml(unpack(original)[DOC])
        after = xml(unpack(updated)[DOC])
        self.assertEqual([etree.tostring(p) for p in before.xpath('.//w:pPr|.//w:rPr', namespaces=NS)],
                         [etree.tostring(p) for p in after.xpath('.//w:pPr|.//w:rPr', namespaces=NS)])
        with self.assertRaises(TemplateConflict):
            self.library.publish(key, 1, OWNER, 'Анна', '', change)
        # The original image files are not even present after this restart.
        restarted = TemplateLibrary(self.directory, self.directory / 'missing-bundled-files', CATALOG)
        self.assertEqual(restarted.snapshot(key), (second, updated))
        self.assertEqual(restarted.snapshot(key, 1), (first, original))
        self.assertEqual(restarted.restore(key, 2, 1, OWNER, 'Анна')['active']['version'], 3)
        self.assertEqual(restarted.snapshot(key)[1], original)
        self.assertEqual([r['version'] for r in restarted.history(key)['versions']], [3, 2, 1])

    def test_upload_is_draft_until_required_fields_are_connected(self):
        key = 'specons'
        doc = Document()
        doc.add_paragraph('Новый договор на оказание услуг.')
        raw = io.BytesIO()
        doc.save(raw)
        uploaded = self.library.upload(key, 1, OWNER, 'новый.docx', raw.getvalue())
        self.assertTrue(uploaded['problems'])
        self.assertEqual(self.library.active_version(key), 1)
        self.assertIsNone(self.library.editor(key, str(uuid4()))['draft'])
        draft_id = uploaded['draft']['id']
        with self.assertRaises(TemplateError):
            self.library.publish(key, 1, OWNER, 'Анна', '', [], draft_id)
        with self.assertRaises(TemplateConflict):
            self.library.publish(key, 1, str(uuid4()), 'Другой', '', [], draft_id)
        block = uploaded['blocks'][0]
        fields = ' '.join(field['key'] for field in uploaded['fields'] if field['required'])
        self.assertEqual(self.library.publish(key, 1, OWNER, 'Анна', 'Новый договор',
            [(block['id'], block['text'] + ' ' + fields)], draft_id)['active']['version'], 2)
        self.assertIsNone(self.library.editor(key, OWNER)['draft'])
        self.assertFalse(self.library.documents.inspect(key, self.library.snapshot(key)[1])['problems'])
        self.assertEqual(self.library.history(key)['versions'][0]['source'], 'upload')

    def test_rejects_unknown_macro_invalid_word_and_missing_fields(self):
        key = 'passport_security'
        _, raw = self.library.snapshot(key)
        invalid = unpack(raw)
        invalid['word/vbaProject.bin'] = b'not the trusted project'
        for upload, suffix in ((pack(invalid), '.docm'), (b'not a ZIP', '.docx')):
            with self.assertRaises(TemplateError):
                self.library.upload(key, 1, OWNER, 'bad' + suffix, upload)
        data = self.library.editor(key, OWNER)
        # An unsupported marker cannot be published even if other tags remain.
        block = next(b for b in data['blocks'] if b['editable'])
        with self.assertRaisesRegex(TemplateError, 'Неизвестные поля'):
            self.library.publish(key, 1, OWNER, 'Анна', '',
                                 [(block['id'], block['text'] + ' autozamena_999')])
        self.assertEqual(self.library.snapshot(key)[1], raw)
        self.assertEqual(len(self.library.history(key)['versions']), 1)

    def test_missing_catalog_does_not_reseed_from_bundled_templates(self):
        self.library.path.rename(self.directory / 'renamed.sqlite')
        with self.assertRaisesRegex(RuntimeError, 'restore'):
            TemplateLibrary(self.directory, ORIGINALS, CATALOG)
        self.assertFalse(self.library.path.exists())

    def test_concurrent_publications_cannot_overwrite_each_other(self):
        key = 'passport_security'
        data = self.library.editor(key, OWNER)
        block = next(b for b in data['blocks'] if b['editable'] and 'autozamena' not in b['text'])
        def publish(value):
            try:
                result = self.library.publish(key, 1, str(uuid4()), value, '',
                    [(block['id'], block['text'] + ' ' + value)])
                return result['active']['version']
            except TemplateConflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(publish, ['Редакция А', 'Редакция Б']))
        self.assertCountEqual(results, [2, 'conflict'])
        self.assertEqual(len(self.library.history(key)['versions']), 2)
