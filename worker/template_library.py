"""Durable single source of truth for contract templates and their history."""
from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import shutil
import sqlite3
from uuid import uuid4

from .template_documents import TemplateDocuments, TemplateError, FILES, MAX_FILE

MAX_STORAGE = 256 * 1024 * 1024
MIN_FREE = 100 * 1024 * 1024


class TemplateConflict(TemplateError):
    pass


class TemplateNotFound(TemplateError):
    pass


def clock():
    return datetime.now(timezone.utc).isoformat()


def digest(content):
    return sha256(content).hexdigest()


class TemplateLibrary:
    def __init__(self, directory: Path, originals: Path, catalog):
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'template-library.sqlite'
        self.marker = self.directory / 'template-library.initialized'
        self.catalog = {entry['id']: entry for entry in catalog}
        if set(self.catalog) != set(FILES):
            raise RuntimeError('Template catalog and worker disagree')
        # A deleted/corrupt catalog is an operational error, not permission
        # to silently seed old bundled templates again.
        if self.marker.exists() and not self.path.is_file():
            raise RuntimeError('Template library missing; restore the persistent backup')
        if not self.path.exists():
            documents = TemplateDocuments(originals)
            seeds = {}
            for key in self.catalog:
                raw = documents.initial(key)
                if documents.inspect(key, raw)['problems']:
                    raise RuntimeError('Invalid initial template: ' + key)
                seeds[key] = raw
            with closing(sqlite3.connect(self.path, timeout=15)) as db, db:
                db.executescript("""
                    PRAGMA journal_mode=WAL;
                    CREATE TABLE template_versions (
                        template_id TEXT NOT NULL, version INTEGER NOT NULL,
                        created_at TEXT NOT NULL, author_id TEXT, author_name TEXT NOT NULL,
                        source TEXT NOT NULL, note TEXT NOT NULL, sha256 TEXT NOT NULL,
                        size INTEGER NOT NULL, content BLOB NOT NULL,
                        PRIMARY KEY(template_id,version)
                    );
                    CREATE TABLE template_active (
                        template_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
                        FOREIGN KEY(template_id,version) REFERENCES template_versions(template_id,version)
                    );
                    CREATE TABLE template_drafts (
                        id TEXT PRIMARY KEY, template_id TEXT NOT NULL, owner_id TEXT NOT NULL,
                        base_version INTEGER NOT NULL, filename TEXT NOT NULL, created_at TEXT NOT NULL,
                        sha256 TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL,
                        UNIQUE(template_id,owner_id)
                    );
                """)
                for key, raw in seeds.items():
                    self._insert(db, key, 1, raw, None, 'Исходная версия', 'initial',
                                 'Перенос действующего шаблона в библиотеку')
                    db.execute('INSERT INTO template_active VALUES (?,1)', (key,))
        with self.connection() as db:
            if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise RuntimeError('Template library is damaged')
            if {r[0] for r in db.execute('SELECT template_id FROM template_active')} != set(self.catalog):
                raise RuntimeError('Template library is incomplete')
            seeds = {key: self._content(self._row(db, key, 1)) for key in self.catalog}
            for key in self.catalog:
                self._content(self._active(db, key))
        # Even macro donors and field meanings come from the immutable first
        # revisions after migration; image rebuilds cannot change them.
        self.documents = TemplateDocuments(originals=seeds)
        self.marker.touch(exist_ok=True)

    def connection(self):
        db = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=15000')
        return closing(db)

    def _key(self, key):
        if key not in self.catalog:
            raise TemplateNotFound('Шаблон не найден.')

    def _row(self, db, key, version):
        self._key(key)
        row = db.execute('SELECT * FROM template_versions WHERE template_id=? AND version=?',
                         (key, version)).fetchone()
        if not row:
            raise TemplateNotFound('Версия шаблона не найдена.')
        return row

    def _active(self, db, key):
        self._key(key)
        row = db.execute('SELECT v.* FROM template_active a JOIN template_versions v USING(template_id,version) WHERE a.template_id=?',
                         (key,)).fetchone()
        if not row:
            raise TemplateError('Активный шаблон недоступен. Восстановите библиотеку из резервной копии.')
        return row

    @staticmethod
    def _content(row):
        raw = row['content']
        if len(raw) != row['size'] or digest(raw) != row['sha256']:
            raise TemplateError('Контрольная сумма не совпадает. Документ не будет создан из повреждённого шаблона.')
        return raw

    @staticmethod
    def _metadata(row):
        return {
            'version': row['version'], 'publishedAt': row['created_at'],
            'author': row['author_name'], 'source': row['source'], 'note': row['note'],
            'size': row['size'], 'sha256': row['sha256'],
        }

    @staticmethod
    def _insert(db, key, version, raw, actor_id, actor_name, source, note):
        db.execute('INSERT INTO template_versions VALUES (?,?,?,?,?,?,?,?,?,?)',
                   (key, version, clock(), actor_id, actor_name, source, note, digest(raw), len(raw), raw))

    def _budget(self, db, additional):
        total = sum(db.execute(f'SELECT COALESCE(SUM(size),0) FROM {table}').fetchone()[0]
                    for table in ('template_versions', 'template_drafts'))
        if additional > MAX_FILE or total + additional > MAX_STORAGE or shutil.disk_usage(self.directory).free < MIN_FREE + max(0, additional) * 2:
            raise TemplateError('Недостаточно места для новой версии. Сохранённые шаблоны и история не изменены.')

    def list(self):
        with self.connection() as db:
            rows = {r['template_id']: r for r in db.execute("""
                SELECT v.template_id,v.version,v.created_at,v.author_name,v.source,v.note,v.size,v.sha256
                  FROM template_active a JOIN template_versions v USING(template_id,version)
            """)}
            if set(rows) != set(self.catalog):
                raise TemplateError('Активный шаблон недоступен. Восстановите библиотеку из резервной копии.')
            return [dict(info, active=self._metadata(rows[key]),
                         versions=db.execute('SELECT count(*) FROM template_versions WHERE template_id=?', (key,)).fetchone()[0])
                    for key, info in self.catalog.items()]

    def history(self, key):
        self._key(key)
        with self.connection() as db:
            active = self._active(db, key)['version']
            rows = db.execute('SELECT version,created_at,author_name,source,note,size,sha256 FROM template_versions WHERE template_id=? ORDER BY version DESC', (key,)).fetchall()
            return {'activeVersion': active, 'versions': [self._metadata(r) for r in rows]}

    def active_version(self, key):
        with self.connection() as db:
            return self._active(db, key)['version']

    def snapshot(self, key, version=None):
        with self.connection() as db:
            row = self._active(db, key) if version is None else self._row(db, key, version)
            return self._metadata(row), self._content(row)

    def _expected(self, db, key, expected):
        row = self._active(db, key)
        if row['version'] != expected:
            raise TemplateConflict('Шаблон уже обновлён другим сотрудником. Откройте актуальную версию заново.')
        return row

    def editor(self, key, owner=None, *, draft_id=None):
        with self.connection() as db:
            row = self._active(db, key)
            draft = db.execute('SELECT * FROM template_drafts WHERE template_id=? AND owner_id=?',
                               (key, owner)).fetchone() if owner else None
            if draft_id and (not draft or draft['id'] != draft_id):
                raise TemplateNotFound('Черновик не найден.')
            stale = bool(draft and draft['base_version'] != row['version'])
            if stale and draft_id:
                raise TemplateConflict('Черновик относится к предыдущей версии. Загрузите файл заново.')
            meta = self._metadata(row)
            raw = self._content(draft if draft and not stale else row)
            details = {'id': draft['id'], 'filename': draft['filename'], 'createdAt': draft['created_at']} if draft else None
        return {'template': self.catalog[key], 'active': meta, 'draft': details,
                'staleDraft': stale, **self.documents.inspect(key, raw)}

    def upload(self, key, expected, owner, filename, raw):
        self._key(key)
        suffix = Path(filename).suffix.lower()
        if suffix not in {'.docx', '.docm'}:
            raise TemplateError('Выберите документ DOCX или DOCM.')
        with self.connection() as db:
            self._expected(db, key, expected)
        content = self.documents.prepare(key, raw, suffix)
        with self.connection() as db, db:
            db.execute('BEGIN IMMEDIATE')
            self._expected(db, key, expected)
            old = db.execute('SELECT size FROM template_drafts WHERE template_id=? AND owner_id=?',
                             (key, owner)).fetchone()
            self._budget(db, len(content) - (old['size'] if old else 0))
            draft_id = str(uuid4())
            db.execute('DELETE FROM template_drafts WHERE template_id=? AND owner_id=?', (key, owner))
            db.execute('INSERT INTO template_drafts VALUES (?,?,?,?,?,?,?,?,?)', (
                draft_id, key, owner, expected, filename[:180], clock(),
                digest(content), len(content), content))
        return self.editor(key, owner, draft_id=draft_id)

    def discard(self, key, owner):
        self._key(key)
        with self.connection() as db, db:
            db.execute('DELETE FROM template_drafts WHERE template_id=? AND owner_id=?', (key, owner))
        return self.editor(key, owner)

    def publish(self, key, expected, owner, author, note, changes, draft_id=None):
        with self.connection() as db:
            row = self._expected(db, key, expected)
            draft = None
            if draft_id:
                draft = db.execute('SELECT * FROM template_drafts WHERE id=? AND template_id=? AND owner_id=?',
                                   (draft_id, key, owner)).fetchone()
                if not draft or draft['base_version'] != expected:
                    raise TemplateConflict('Черновик устарел. Откройте шаблон заново.')
            raw = self._content(draft if draft else row)
        content = self.documents.edit(key, raw, changes)
        with self.connection() as db, db:
            db.execute('BEGIN IMMEDIATE')
            current = self._expected(db, key, expected)
            if draft_id and not db.execute('SELECT 1 FROM template_drafts WHERE id=? AND owner_id=? AND sha256=?',
                                           (draft_id, owner, draft['sha256'])).fetchone():
                raise TemplateConflict('Черновик был заменён. Откройте его заново.')
            version = self._publish_content(db, key, current, content, owner, author,
                                            'upload' if draft else 'edit', note)
            if draft_id:
                db.execute('DELETE FROM template_drafts WHERE id=? AND owner_id=?', (draft_id, owner))
        return {'active': self.snapshot(key, version)[0]}

    def _publish_content(self, db, key, current, content, owner, author, source, note):
        if digest(content) == current['sha256']:
            return current['version']
        self._budget(db, len(content))
        version = current['version'] + 1
        self._insert(db, key, version, content, owner, author, source, note)
        db.execute('UPDATE template_active SET version=? WHERE template_id=? AND version=?',
                   (version, key, current['version']))
        return version

    def restore(self, key, expected, version, owner, author):
        with self.connection() as db:
            self._expected(db, key, expected)
            raw = self._content(self._row(db, key, version))
        info = self.documents.inspect(key, raw)
        if info['problems']:
            raise TemplateError('; '.join(info['problems']))
        with self.connection() as db, db:
            db.execute('BEGIN IMMEDIATE')
            current = self._expected(db, key, expected)
            active = self._publish_content(db, key, current, raw, owner, author, 'restore',
                                           'Восстановление версии ' + str(version))
        return {'active': self.snapshot(key, active)[0]}
