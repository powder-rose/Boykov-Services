import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile
import io

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
                    ser_fields=dict(object_address='Москва, Тестовая 1', object_name='Тестовый объект', email='test@example.com', cost_month=5200, months_count=3))

    def test_worker_is_private(self):
        self.assertEqual(TestClient(service.app).get('/health').status_code, 401)
        self.assertEqual(self.client.get('/health').status_code, 200)

    def test_all_five_original_templates_generate_valid_word_files(self):
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
