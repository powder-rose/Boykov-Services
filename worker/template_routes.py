"""Private worker routes; the Node gateway supplies the authenticated actor."""
from typing import Literal
from uuid import UUID
from contextlib import contextmanager
from threading import BoundedSemaphore

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, ConfigDict

from .template_documents import MAX_FILE, TemplateError
from .template_library import TemplateConflict, TemplateNotFound


class Actor(BaseModel):
    model_config = ConfigDict(extra='forbid')
    actorId: UUID
    actorName: str = Field(min_length=1, max_length=160)


class Change(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=100)
    text: str = Field(max_length=8000)
    format: 'ParagraphFormat | None' = None


class ParagraphFormat(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    align: Literal['left', 'center', 'right', 'justify'] | None = None
    fontSize: int | None = Field(default=None, ge=8, le=36)
    bold: bool | None = None
    italic: bool | None = None
    underline: bool | None = None


def edits(changes):
    return [(c.id, c.text, c.format.model_dump(exclude_none=True) if c.format else None) for c in changes]


class Publication(Actor):
    expectedVersion: int = Field(ge=1)
    draftId: UUID | None = None
    changes: list[Change] = Field(default_factory=list, max_length=1000)
    note: str = Field(default='', max_length=300)


class Restoration(Actor):
    expectedVersion: int = Field(ge=1)
    version: int = Field(ge=1)


def register_template_routes(app, library):
    # DOCX packages may expand substantially. Limit concurrent materialization
    # without blocking normal contract creation or lightweight version lists.
    slots = BoundedSemaphore(2)

    @contextmanager
    def operation():
        if not slots.acquire(blocking=False):
            raise HTTPException(429, 'Библиотека обрабатывает другие файлы. Повторите через несколько секунд.')
        try:
            yield
        finally:
            slots.release()

    @app.exception_handler(TemplateError)
    async def handle_template_error(request: Request, exc: TemplateError):
        status = 409 if isinstance(exc, TemplateConflict) else 404 if isinstance(exc, TemplateNotFound) else 422
        return JSONResponse({'detail': str(exc)}, status_code=status)

    @app.get('/templates')
    def templates():
        return {'templates': library.list()}

    @app.get('/templates/{key}/history')
    def history(key: str):
        return library.history(key)

    @app.get('/templates/{key}/editor')
    def editor(key: str, owner: UUID | None = None):
        with operation():
            return library.editor(key, str(owner) if owner else None)

    @app.get('/templates/{key}/preview')
    def published_preview(key: str):
        with operation():
            return library.editor(key)

    @app.post('/templates/{key}/preview')
    def preview(key: str, data: Publication):
        with operation():
            return library.preview(key, data.expectedVersion, str(data.actorId), edits(data.changes),
                                   str(data.draftId) if data.draftId else None)

    @app.post('/templates/{key}/draft')
    def upload(key: str, expectedVersion: int = Form(..., ge=1), actorId: UUID = Form(...),
               file: UploadFile = File(...)):
        with operation():
            raw = file.file.read(MAX_FILE + 1)
            if len(raw) > MAX_FILE:
                raise TemplateError('Допустим файл размером до 20 МБ.')
            return library.upload(key, expectedVersion, str(actorId), file.filename or '', raw)

    @app.post('/templates/{key}/discard')
    def discard(key: str, actor: Actor):
        with operation():
            return library.discard(key, str(actor.actorId))

    @app.post('/templates/{key}/publish')
    def publish(key: str, data: Publication):
        with operation():
            return library.publish(key, data.expectedVersion, str(data.actorId), data.actorName,
                                   data.note.strip(), edits(data.changes),
                                   str(data.draftId) if data.draftId else None)

    @app.post('/templates/{key}/restore')
    def restore(key: str, data: Restoration):
        with operation():
            return library.restore(key, data.expectedVersion, data.version, str(data.actorId), data.actorName)

    @app.get('/templates/{key}/files/{version}')
    def download(key: str, version: int, format: Literal['docx', 'docm'] = 'docm'):
        with operation():
            _, raw = library.snapshot(key, version)
            if format == 'docx':
                raw = library.documents.clean(key, raw)
        mime = ('application/vnd.ms-word.document.macroEnabled.12' if format == 'docm'
                else 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        return Response(raw, media_type=mime, headers={
            'Content-Disposition': f'attachment; filename="{key}-v{version}.{format}"',
            'Cache-Control': 'private, no-store',
        })
