"""Private HTTP adapter for the original document core. No messenger imports."""
from __future__ import annotations
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4
from zipfile import ZipFile, BadZipFile

from dateutil.relativedelta import relativedelta
from dotenv import load_dotenv, dotenv_values
from fastapi import FastAPI, Request, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from num2words import num2words
from pydantic import BaseModel, Field, field_validator
from PIL import Image
from .vendor.core.misc import Miscellaneous, DocumentExtractionError, AIServiceError, MissingCompanyDetailsError

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')
for key, value in dotenv_values(ROOT / '.env.contracts').items():
    if key in {'YANDEX_FOLDER_ID', 'YANDEX_API_KEY', 'YANDEXGPT_API_KEY'} and value:
        os.environ[key] = value
DATA = Path(os.getenv('CONTRACTS_DATA_DIR', ROOT / os.getenv('DATA_DIR', 'data') / 'contracts')).resolve()
DATA.mkdir(parents=True, exist_ok=True)
TOKEN = os.getenv('WORKER_TOKEN', '')
DB = DATA / 'jobs.sqlite'
Image.MAX_IMAGE_PIXELS = 12_000_000
TEMPLATES = json.loads((ROOT / 'shared/templates.json').read_text())
TEMPLATE_IDS = {t['id'] for t in TEMPLATES}
MAX_FILE = 20 * 1024 * 1024
pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='contracts')
creation_lock = threading.Lock()
logger = logging.getLogger(__name__)

def connect():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    return db

with connect() as db:
    db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT, title TEXT, status TEXT, created TEXT, result TEXT, error TEXT, input_hash TEXT);')
    db.execute("UPDATE jobs SET status='failed', error='Обработка прервана перезапуском сервиса. Запустите задачу заново.' WHERE status IN ('queued', 'running')")

class WebCore(Miscellaneous):
    def integer_texted(self, value: int) -> str:
        # Deterministic arithmetic. AI is used for extraction, not number spelling.
        return str(num2words(value, lang='ru')).capitalize()

    @staticmethod
    def _extract_doc_text(path: Path) -> str:
        try:
            process = subprocess.run(['antiword', str(path)], capture_output=True, timeout=30, check=True)
            return process.stdout.decode('utf-8', errors='replace')
        except (OSError, subprocess.SubprocessError) as exc:
            raise DocumentExtractionError('Не удалось прочитать DOC. Сохраните его как DOCX и загрузите снова.') from exc

core = WebCore(bot_dir=DATA, state_dir=DATA, require_ai=False)
ai_configured = lambda: bool(core.YANDEX_FOLDER_ID and core.YANDEX_API_KEY)

class Terms(BaseModel):
    cost_month: int = Field(default=5200, ge=0, le=1_000_000_000)
    months_count: int = Field(default=3, ge=1, le=120)
    advance: int = Field(default=100, ge=0, le=100)
    advance_period: Literal['за один месяц', 'за два месяца', 'за три месяца'] = 'за один месяц'
    visits_frequency: Literal['Ежеквартально', 'Ежемесячно', 'Один раз в два месяца'] = 'Ежеквартально'
    termination_period: Literal['90 (девяносто) календарных дней', '60 (шестьдесят) календарных дней', '30 (тридцать) календарных дней'] = '30 (тридцать) календарных дней'
    object_address: str = Field(default='', max_length=1000)
    object_name: str = Field(default='', max_length=500)
    email: str = Field(default='', max_length=254)

class Generation(BaseModel):
    requestId: str
    template: Literal['passport_security', 'passport_security_agreed', 'sout', 'specons', 'ser']
    surname: str = Field(min_length=2, max_length=80, pattern=r'^[А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z -]+$')
    cost: int = Field(default=0, ge=0, le=1_000_000_000)
    complects: int = Field(default=0, ge=0, le=100000)
    workplaces_count: int = Field(default=1, ge=1, le=100000)
    company: list[str] = Field(min_length=14, max_length=14)
    ser_fields: Terms = Field(default_factory=Terms)
    allowIncomplete: bool = False

    @field_validator('requestId')
    @classmethod
    def valid_uuid(cls, value):
        return str(UUID(value))

    @field_validator('company')
    @classmethod
    def valid_company(cls, values):
        if any(len(value) > 2000 for value in values):
            raise ValueError('Реквизит не должен превышать 2000 символов')
        return [value.strip() for value in values]

def public_job(row, detailed=False):
    result = json.loads(row['result']) if row['result'] else None
    value = dict(id=row['id'], kind=row['kind'], title=row['title'], status=row['status'], createdAt=row['created'], error=row['error'])
    value['downloadUrl'] = f"/api/contracts/files/{row['id']}" if row['kind'] == 'generate' and row['status'] == 'completed' else None
    if detailed:
        value['result'] = result
    return value

def find_job(job_id):
    try:
        job_id = str(UUID(job_id))
    except ValueError:
        raise HTTPException(404, 'Задача не найдена')
    with connect() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, 'Задача не найдена')
    return row

def update(job_id, status, result=None, error=None):
    with connect() as db:
        db.execute('UPDATE jobs SET status=?, result=?, error=? WHERE id=?', (status, json.dumps(result, ensure_ascii=False) if result is not None else None, error, job_id))

def create_job(job_id, kind, title, signature, action, cleanup_existing=None):
    with creation_lock, connect() as db:
        existing = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if existing:
            if cleanup_existing:
                cleanup_existing()
            if existing['input_hash'] != signature:
                raise HTTPException(409, 'Эта задача уже создана с другими данными. Создайте новую.')
            return public_job(existing, True)
        if db.execute("SELECT count(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0] >= 20:
            raise HTTPException(429, 'Очередь заполнена. Дождитесь завершения текущих задач.')
        db.execute('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)', (job_id, kind, title, 'queued', datetime.now(timezone.utc).isoformat(), signature))
    pool.submit(run_job, job_id, action)
    return public_job(find_job(job_id), True)

def run_job(job_id, action):
    update(job_id, 'running')
    try:
        update(job_id, 'completed', action())
    except MissingCompanyDetailsError as exc:
        update(job_id, 'failed', error='Не заполнены реквизиты: ' + ', '.join(exc.missing_fields))
    except DocumentExtractionError as exc:
        update(job_id, 'failed', error=str(exc))
    except AIServiceError:
        update(job_id, 'failed', error='Не удалось получить ответ Yandex AI. Проверьте ключи, квоту и соединение с Yandex Cloud.')
    except Exception as exc:
        logger.error('Document task failed: %s', type(exc).__name__)
        update(job_id, 'failed', error='Не удалось подготовить документ. Проверьте данные и доступность диска.')

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

@app.middleware('http')
async def authorize(request: Request, call_next):
    supplied = request.headers.get('authorization', '')
    if len(TOKEN) < 32 or not hmac.compare_digest(supplied.encode(), f'Bearer {TOKEN}'.encode()):
        return JSONResponse({'detail': 'Доступ запрещён'}, status_code=401)
    return await call_next(request)

@app.get('/health')
def health():
    usage = core.get_ai_usage_stats(recent_limit=1)
    usage.pop('recent', None)
    return {'aiConfigured': ai_configured(), 'templates': len(TEMPLATES), 'usage': usage}

@app.get('/jobs')
def jobs():
    with connect() as db:
        return {'jobs': [public_job(row) for row in db.execute('SELECT * FROM jobs ORDER BY created DESC')]}

@app.get('/jobs/{job_id}')
def job(job_id: str):
    return public_job(find_job(job_id), True)

def check_archive(path):
    if path.suffix not in {'.docx', '.docm'}:
        return
    try:
        with ZipFile(path) as archive:
            if sum(item.file_size for item in archive.infolist()) > 128 * 1024 * 1024:
                raise HTTPException(413, 'Документ слишком большой после распаковки.')
    except BadZipFile:
        raise HTTPException(400, 'Файл Word повреждён.')

@app.post('/extract', status_code=202)
async def extract(requestId: str = Form(...), mode: str = Form('text'), text: str = Form(''), file: UploadFile | None = File(None)):
    if not ai_configured():
        raise HTTPException(503, 'Добавьте ключи Yandex AI в .env.contracts и перезапустите сервис.')
    try:
        job_id = str(UUID(requestId))
    except ValueError:
        raise HTTPException(400, 'Некорректный идентификатор задачи.')
    if mode not in {'text', 'document', 'scan', 'image'}:
        raise HTTPException(400, 'Неизвестный источник реквизитов.')
    if len(text) > 100000:
        raise HTTPException(413, 'Текст не должен превышать 100 000 символов.')
    source = None
    directory = DATA / 'uploads'
    directory.mkdir(exist_ok=True)
    raw = b''
    if mode == 'text':
        if not text.strip():
            raise HTTPException(400, 'Вставьте текст с реквизитами.')
    else:
        if file is None:
            raise HTTPException(400, 'Выберите файл.')
        suffix = Path(file.filename or '').suffix.lower()
        supported = {'document': {'.pdf', '.doc', '.docx', '.docm'}, 'scan': {'.pdf'}, 'image': {'.png', '.jpg', '.jpeg'}}[mode]
        if suffix not in supported:
            raise HTTPException(415, 'Этот формат не подходит для выбранного источника.')
        raw = await file.read(MAX_FILE + 1)
        await file.close()
        if not raw or len(raw) > MAX_FILE:
            raise HTTPException(413, 'Допустим непустой файл размером до 20 МБ.')
        source = directory / (uuid4().hex + suffix)
        source.write_bytes(raw)
        try:
            check_archive(source)
        except Exception:
            source.unlink(missing_ok=True)
            raise
    signature = hashlib.sha256(mode.encode() + text.encode() + raw).hexdigest()
    def action():
        try:
            methods = {'text': lambda: core.sent_message_to_ai(text), 'document': lambda: core.sent_doc_to_ai(source), 'scan': lambda: core.sent_pdf_scan_to_ai(source), 'image': lambda: core.sent_image_to_ai(source)}
            company = methods[mode]()
            return {'company': company, 'missing': core.validate_company_data(company, raise_on_missing=False)}
        finally:
            if source:
                source.unlink(missing_ok=True)
    try:
        return create_job(job_id, 'extract', 'Распознавание реквизитов', signature, action,
                          cleanup_existing=lambda: source.unlink(missing_ok=True) if source else None)
    except Exception:
        if source:
            source.unlink(missing_ok=True)
        raise

def generate_document(data: Generation, job_id: str):
    now = datetime.now()
    ending = now + relativedelta(years=1)
    fields = data.ser_fields.model_dump()
    fields = {key: str(value) for key, value in fields.items()}
    user = {'lastname': data.surname[:2].upper(), 'cost': data.cost, 'complects': data.complects,
            'count_print': 3900 * data.complects, 'count_sending': 3900 * data.complects + 1000 if data.complects else 0,
            'ending': f'{ending.day} {core.GENITIVUS[ending.month]} {ending.year} года', 'ser_fields': fields}
    users = {1: user}
    contract_number = core.get_bot_doc_num(users, 1)
    kwargs = {'allow_incomplete': data.allowIncomplete}
    if data.template == 'ser':
        output = core.bot_insert_req_ser(users, 1, data.company, contract_number, core.integer_texted(data.ser_fields.cost_month * data.ser_fields.months_count), **kwargs)
    else:
        invoice = core.get_bot_count_num(users, 1)
        args = [users, 1, data.company, contract_number, invoice, core.integer_texted(data.cost)]
        if data.template == 'specons':
            output = core.bot_insert_req(*args, core.integer_texted(user['count_sending']), **kwargs)
        elif data.template == 'sout':
            output = core.bot_insert_req_sout(*args, str(data.workplaces_count), **kwargs)
        elif data.template == 'passport_security_agreed':
            output = core.bot_insert_req_passport_security_agreed(*args, **kwargs)
        else:
            output = core.bot_insert_req_passport_security(*args, **kwargs)
    final = DATA / 'files' / f'{job_id}.docm'
    final.parent.mkdir(exist_ok=True)
    shutil.move(output, final)
    return {'number': contract_number, 'fileName': final.name, 'draft': data.allowIncomplete,
            'missing': core.validate_company_data(data.company, raise_on_missing=False)}

@app.post('/generate', status_code=202)
def generate(data: Generation):
    missing = core.validate_company_data(data.company, raise_on_missing=False)
    if missing and not data.allowIncomplete:
        raise HTTPException(422, 'Заполните реквизиты: ' + ', '.join(missing))
    if data.template == 'ser':
        terms = data.ser_fields
        if not terms.object_address.strip() or not terms.object_name.strip() or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', terms.email):
            raise HTTPException(422, 'Укажите адрес, наименование объекта и корректную почту заказчика.')
    job_id = data.requestId
    signature = hashlib.sha256(data.model_dump_json().encode()).hexdigest()
    title = data.company[13] or data.company[4] or 'Черновик документа'
    return create_job(job_id, 'generate', title, signature, lambda: generate_document(data, job_id))

@app.get('/files/{job_id}')
def download(job_id: str):
    row = find_job(job_id)
    if row['kind'] != 'generate' or row['status'] != 'completed':
        raise HTTPException(404, 'Документ ещё не готов.')
    path = DATA / 'files' / f"{row['id']}.docm"
    if not path.is_file():
        raise HTTPException(404, 'Файл недоступен.')
    return FileResponse(path, filename=f"contract-{row['id']}.docm", media_type='application/vnd.ms-word.document.macroEnabled.12')
