import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile
import io
from datetime import datetime
from lxml import etree

WORKSPACE = tempfile.TemporaryDirectory(prefix='boykov-worker-test-')
os.environ['CONTRACTS_DATA_DIR'] = WORKSPACE.name
os.environ['WORKER_TOKEN'] = 'test-worker-token-' + 'x' * 32
from worker import service
from fastapi.testclient import TestClient

COMPANY = ['ООО', 'генерального директора', 'генеральный директор', 'Иванова Ивана Ивановича', 'Иванов Иван Иванович',
           '7701234567', 'г. Москва, ул. Тестовая, д. 1', 'Тестовый банк', '40702810000000000001', '30101810000000000001', '044525001', '770101001', '1027700000000', 'ТЕСТОВАЯ КОМПАНИЯ']

class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(service.app, headers={'Authorization': 'Bearer ' + os.environ['WORKER_TOKEN']})

    def await_job(self, job_id):
        for _ in range(200):
            response = self.client.get('/jobs/' + job_id)
            self.assertEqual(response.status_code, 200)
            job = response.json()
            if job['status'] in {'completed', 'failed'}:
                return job
            time.sleep(.025)
        self.fail('Document task did not finish')

    def payload(self, template):
        return dict(requestId=str(uuid4()), template=template, surname='Тестовая', cost=15000, complects=2, workplaces_count=3, company=COMPANY,
                    one_time_services=[dict(name='Проверка электроустановки', working_days=10, quantity=1, price=15000)] if template == 'ser_one_time' else [],
                    ser_fields=dict(object_address='Москва, Тестовая 1', object_name='Тестовый объект', email='test@example.com', cost_month=5200, months_count=3))

    def replacement_values(self, archive):
        ns = {'w': service.core.WORD_NS}
        root = etree.fromstring(archive.read('word/document.xml'))
        values = {}
        for row in root.xpath('./w:body/w:tbl[1]/w:tr', namespaces=ns):
            cells = row.findall('w:tc', ns)
            if len(cells) == 5:
                key = ''.join(cells[-1].xpath('.//w:t/text()', namespaces=ns))
                if key.startswith('autozamena_'):
                    values[key] = ''.join(cells[-2].xpath('.//w:t/text()', namespaces=ns))
        return values

    def test_worker_is_private(self):
        self.assertEqual(TestClient(service.app).get('/health').status_code, 401)
        self.assertEqual(self.client.get('/health').status_code, 200)

    def test_all_six_templates_generate_valid_word_files(self):
        self.assertEqual(len(service.TEMPLATE_IDS), 6)
        for template in service.TEMPLATE_IDS:
            with self.subTest(template=template):
                payload = self.payload(template)
                response = self.client.post('/generate', json=payload)
                self.assertEqual(response.status_code, 202, response.text)
                job = self.await_job(payload['requestId'])
                self.assertEqual(job['status'], 'completed', job)
                result = self.client.get('/files/' + job['id'])
                self.assertEqual(result.status_code, 200)
                with ZipFile(io.BytesIO(result.content)) as archive:
                    xml = archive.read('word/document.xml').decode()
                    self.assertIn('ТЕСТОВАЯ КОМПАНИЯ', xml)
                    self.assertIn(job['result']['number'], xml)
                    self.assertRegex(job['result']['number'], r'^ТЕ\d{6}-\d+$')
                    self.assertNotIn('WEB-', xml)
                    self.assertIn('7701234567', xml)
                    self.assertEqual(archive.testzip(), None)

    def test_ser_period_always_includes_contract_month(self):
        for day in (1, 15, 16, 30):
            with self.subTest(day=day):
                start = datetime(2026, 11, day)
                self.assertEqual(service.core._build_ser_service_period(start, '3'), 'ноябрь 2026, декабрь 2026, январь 2027')
                self.assertEqual(service.core._build_ser_invoice_period(start, '3'), 'за ноябрь, декабрь 2026 года, январь 2027 года')
        for start, expected in [(datetime(2026, 12, 31), 'декабрь 2026, январь 2027'), (datetime(2028, 2, 29), 'февраль 2028, март 2028')]:
            with self.subTest(start=start):
                self.assertEqual(service.core._build_ser_service_period(start, '2'), expected)

    def test_specons_uses_updated_vat_contract_and_existing_macro(self):
        payload = self.payload('specons')
        self.assertEqual(self.client.post('/generate', json=payload).status_code, 202)
        job = self.await_job(payload['requestId'])
        self.assertEqual(job['status'], 'completed', job)
        ns = {'w': service.core.WORD_NS}
        with ZipFile(io.BytesIO(self.client.get('/files/' + job['id']).content)) as archive:
            root = etree.fromstring(archive.read('word/document.xml'))
            text = ''.join(root.xpath('.//w:t/text()', namespaces=ns))
            self.assertEqual(text.count('Итого, в том числе НДС (5%):'), 3)
            self.assertIn('3 000 (три тысячи) рублей за 1 (один) человеко-час', text)
            self.assertIn('Заказчик обязуется подписать Акт в течение 5 календарных дней', text)
            values = self.replacement_values(archive)
            self.assertEqual(set(values), {f'autozamena_{index:03d}' for index in range(1, 21)})
            self.assertEqual(values['autozamena_013'], '15000')
            self.assertEqual(len(root.xpath('.//w:control[@w:name="CommandButton1"]', namespaces=ns)), 1)
            self.assertIn('word/activeX/activeX1.bin', archive.namelist())
            with ZipFile(service.core.CORE_DIR / 'ООО СПЕЦЭНЕРГОРАЗВИТИЕ_РАЗОВЫЕ.docm') as previous:
                self.assertEqual(archive.read('word/vbaProject.bin'), previous.read('word/vbaProject.bin'))

    def test_ai_role_typo_is_corrected_before_returning_editable_fields(self):
        company = COMPANY.copy()
        company[0:5] = ['ИП', 'индивидуательного предпринимателя', 'индивидуальный предприниматель',
                        'Привалова Андрея Евгеньевича', 'Привалов Андрей Евгеньевич']
        job_id = str(uuid4())
        with patch.object(service.core, '_send_text_to_gpt', return_value='\n'.join(company)), patch.object(service, 'ai_configured', return_value=True):
            response = self.client.post('/extract', data={'requestId': job_id, 'mode': 'text', 'text': 'ИП Привалов Андрей Евгеньевич'})
            self.assertEqual(response.status_code, 202)
            job = self.await_job(job_id)
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['result']['company'][1:3], ['Индивидуального предпринимателя', 'Индивидуальный предприниматель'])
        self.assertEqual(job['result']['company'][3:], company[3:])

    def test_saved_or_manually_entered_role_typo_is_corrected_in_document(self):
        for role in ('Индивидуательного предпринимателя', 'Индивидуального предпринимателя'):
            with self.subTest(role=role):
                payload = self.payload('specons')
                payload['company'] = COMPANY.copy()
                payload['company'][0:5] = ['ИП', role, 'Индивидуальный предприниматель',
                                          'Привалова Андрея Евгеньевича', 'Привалов Андрей Евгеньевич']
                self.assertEqual(self.client.post('/generate', json=payload).status_code, 202)
                job = self.await_job(payload['requestId'])
                self.assertEqual(job['status'], 'completed', job)
                with ZipFile(io.BytesIO(self.client.get('/files/' + job['id']).content)) as archive:
                    self.assertEqual(self.replacement_values(archive)['autozamena_005'], 'Индивидуального предпринимателя')

    def test_role_correction_preserves_representatives_names_and_other_fields(self):
        company = COMPANY.copy()
        company[1] = 'Представителя индивидуательного предпринимателя'
        company[2] = 'Представитель по доверенности'
        company[13] = 'Индивидуательного предпринимателя'  # A company name is not a role.
        corrected = service.core.normalize_company_roles(company)
        self.assertEqual(corrected[1], 'Представителя индивидуального предпринимателя')
        self.assertEqual(corrected[2:], company[2:])
        self.assertEqual(company[1], 'Представителя индивидуательного предпринимателя')
        self.assertEqual(service.core.normalize_company_roles(COMPANY), COMPANY)

    def test_ser_november_16_document_and_invoice_use_the_same_period(self):
        payload = self.payload('ser')
        with patch('worker.vendor.core.misc.datetime') as clock:
            clock.now.return_value = datetime(2026, 11, 16)
            response = self.client.post('/generate', json=payload)
            self.assertEqual(response.status_code, 202)
            job = self.await_job(payload['requestId'])
            self.assertEqual(job['status'], 'completed', job)
        result = self.client.get('/files/' + job['id'])
        with ZipFile(io.BytesIO(result.content)) as archive:
            values = self.replacement_values(archive)
        self.assertEqual(values['autozamena_002'], '16 ноября 2026 года')
        self.assertEqual(values['autozamena_022'], 'ноябрь 2026, декабрь 2026, январь 2027')
        self.assertEqual(values['autozamena_028'], 'за ноябрь, декабрь 2026 года, январь 2027 года')

    def test_ser_one_time_fills_specification_and_keeps_the_macro_button(self):
        payload = self.payload('ser_one_time')
        payload['cost'] = 1  # The API calculates the authoritative total from the rows.
        payload['one_time_services'] = [
            dict(name='Проверка <щита> и изоляции', working_days=7, quantity=2, price=7500),
            dict(name='Подготовка протокола', working_days=10, quantity=1, price=3500),
        ]
        self.assertEqual(self.client.post('/generate', json=payload).status_code, 202)
        job = self.await_job(payload['requestId'])
        self.assertEqual(job['status'], 'completed', job)
        result = self.client.get('/files/' + job['id'])
        ns = {'w': service.core.WORD_NS}
        with ZipFile(io.BytesIO(result.content)) as archive, ZipFile(service.core.CORE_DIR / 'template2.docm') as donor:
            root = etree.fromstring(archive.read('word/document.xml'))
            specification = root.xpath('./w:body/w:tbl[contains(string(.), "Перечень оказываемых услуг")]', namespaces=ns)[0]
            rows = specification.findall('w:tr', ns)
            self.assertEqual(len(rows), 3)
            first = [''.join(cell.xpath('.//w:t/text()', namespaces=ns)) for cell in rows[1].findall('w:tc', ns)]
            self.assertEqual(first, ['1', 'Проверка <щита> и изоляции', '7', '2', 'компл.', '7500', '15000'])
            self.assertEqual(self.replacement_values(archive)['autozamena_013'], '18500')
            self.assertEqual(self.replacement_values(archive)['autozamena_014'], 'Восемнадцать тысяч пятьсот')
            self.assertEqual(len(root.xpath('.//w:control[@w:name="CommandButton1"]', namespaces=ns)), 1)
            self.assertEqual(archive.read('word/vbaProject.bin'), donor.read('word/vbaProject.bin'))
            self.assertEqual(archive.read('word/activeX/activeX1.bin'), donor.read('word/activeX/activeX1.bin'))
            self.assertNotIn('Выберите элемент.', ''.join(specification.xpath('.//w:t/text()', namespaces=ns)))

    def test_ser_one_time_rejects_invalid_or_overflowing_service_rows(self):
        variants = [[], [dict(name='   ', working_days=7, quantity=1, price=1)],
                    [dict(name='Услуга', working_days=0, quantity=1, price=1)],
                    [dict(name='Услуга', working_days=7, quantity=0, price=1)],
                    [dict(name='Услуга', working_days=7, quantity=1, price=-1)],
                    [dict(name='Услуга', working_days=7, quantity=2, price=1000000000)],
                    [dict(name='Услуга', working_days=7, quantity=1, price=1)] * 10]
        for rows in variants:
            with self.subTest(rows=rows):
                payload = self.payload('ser_one_time')
                payload['one_time_services'] = rows
                self.assertEqual(self.client.post('/generate', json=payload).status_code, 422)

    def test_duplicate_generation_does_not_issue_a_second_number(self):
        payload = self.payload('passport_security')
        response = self.client.post('/generate', json=payload)
        self.assertEqual(response.status_code, 202)
        original = self.await_job(payload['requestId'])
        retry = self.client.post('/generate', json=payload)
        self.assertEqual(retry.status_code, 202)
        self.assertEqual(retry.json()['result']['number'], original['result']['number'])
        payload['cost'] += 1
        self.assertEqual(self.client.post('/generate', json=payload).status_code, 409)

    def test_missing_requisites_require_explicit_draft(self):
        payload = self.payload('passport_security')
        payload['company'] = [''] * 14
        self.assertEqual(self.client.post('/generate', json=payload).status_code, 422)
        payload['allowIncomplete'] = True
        self.assertEqual(self.client.post('/generate', json=payload).status_code, 202)
        job = self.await_job(payload['requestId'])
        self.assertEqual(job['status'], 'completed', job)
        self.assertTrue(job['result']['draft'])
        self.assertGreater(len(job['result']['missing']), 0)

    def test_ai_extraction_uses_core_and_returns_editable_fields(self):
        job_id = str(uuid4())
        with patch.object(service.core, 'sent_message_to_ai', return_value=COMPANY) as extract, patch.object(service, 'ai_configured', return_value=True):
            response = self.client.post('/extract', data={'requestId': job_id, 'mode': 'text', 'text': 'Карточка компании'})
            self.assertEqual(response.status_code, 202, response.text)
            job = self.await_job(job_id)
            self.assertEqual(job['result']['company'], COMPANY)
            extract.assert_called_once_with('Карточка компании')

    def test_images_use_the_original_ocr_adapter_and_remove_sources(self):
        job_id = str(uuid4())
        with patch.object(service.core, 'sent_image_to_ai', return_value=COMPANY) as extract, patch.object(service, 'ai_configured', return_value=True):
            response = self.client.post('/extract', data={'requestId': job_id, 'mode': 'image'}, files={'file': ('source.png', b'test-bytes', 'image/png')})
            self.assertEqual(response.status_code, 202)
            self.assertEqual(self.await_job(job_id)['status'], 'completed')
            source = extract.call_args.args[0]
            self.assertFalse(Path(source).exists())

    def test_unconfigured_ai_and_invalid_upload_are_rejected(self):
        with patch.object(service, 'ai_configured', return_value=False):
            self.assertEqual(self.client.post('/extract', data={'requestId': str(uuid4()), 'mode': 'text', 'text': 'test'}).status_code, 503)
        with patch.object(service, 'ai_configured', return_value=True):
            self.assertEqual(self.client.post('/extract', data={'requestId': str(uuid4()), 'mode': 'image'}, files={'file': ('test.exe', b'bytes')}).status_code, 415)

    def test_path_traversal_and_bad_fields_are_rejected(self):
        self.assertEqual(self.client.get('/files/not-a-valid-id').status_code, 404)
        payload = self.payload('ser')
        payload['surname'] = '../../bad'
        self.assertEqual(self.client.post('/generate', json=payload).status_code, 422)
        payload = self.payload('ser')
        payload['ser_fields']['email'] = 'invalid'
        self.assertEqual(self.client.post('/generate', json=payload).status_code, 422)

    @classmethod
    def tearDownClass(cls):
        service.pool.shutdown(wait=True)
        cls.client.close()
        WORKSPACE.cleanup()

if __name__ == '__main__':
    unittest.main()
