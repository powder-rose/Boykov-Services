"""Zenbot comments-only connector. Uses the visible, authorised Studio UI.

No Telegram, article publication, session export, private API or login automation.
An uncertain publication is reported to the hub and never repeated here.
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

HOSTS = {'dzen.ru', 'www.dzen.ru', 'studio.dzen.ru'}
CARD = 'div[class*="editor--comment__block"]'
COMMENT = 'p[aria-label="Текст комментария"]'
REPLY = 'button[data-testid="reply-button"]'
COMPOSER = 'textarea[data-testid="comment-textarea"]'
SEND = 'button[data-testid="send-button"]'
MAX_SCROLLS = 8


def normalize(value):
    return ' '.join(str(value or '').replace('\u200b', '').replace('\u2060', '').replace('\ufeff', '').split())


def unanswered_parameter(value):
    query = parse_qs(urlsplit(value).query, keep_blank_values=True)
    current, legacy = query.get('answer', []), query.get('comments_data', [])
    if current == ['notReply'] and not legacy:
        return ('answer', 'notReply')
    if legacy == ['n_reply'] and not current:
        return ('comments_data', 'n_reply')
    return None


def studio_url(value):
    url = urlsplit(value.strip())
    if url.scheme != 'https' or url.hostname not in HOSTS or url.username or url.password or url.port or '/comments' not in url.path:
        raise ValueError('Нужна HTTPS-ссылка раздела комментариев Студии Дзена.')
    parameter = unanswered_parameter(value.strip())
    query = urlencode([parameter]) if parameter else ''
    return urlunsplit(('https', url.hostname, url.path, query, ''))


def unanswered_studio_url(value):
    canonical = studio_url(value)
    if unanswered_parameter(canonical):
        return canonical
    url = urlsplit(canonical)
    # Older saved configurations lost the current filter when normalized.
    # Restore only the known unanswered view on the already paired channel.
    return urlunsplit((url.scheme, url.netloc, url.path, 'answer=notReply', ''))


def same_studio_channel(a, b):
    first, second = urlsplit(studio_url(a)), urlsplit(studio_url(b))
    return first.netloc == second.netloc and first.path.rstrip('/') == second.path.rstrip('/')


def hub_url(value):
    url = urlsplit(value.strip())
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise ValueError('Укажите HTTPS-адрес Boykov Services без дополнительных путей.')
    return urlunsplit((url.scheme, url.netloc, '', '', ''))


def allowed_link(value, fallback):
    try:
        url = urlsplit(value or '')
        if url.scheme != 'https' or url.hostname not in HOSTS or url.username or url.password or url.port:
            return fallback
        match = re.fullmatch(r'(comment_[A-Za-z0-9_-]{1,180})(?:&[^#]*)?', url.fragment)
        fragment = match.group(1) if match else ''
        return urlunsplit(('https', url.hostname, url.path, '', fragment))
    except ValueError:
        return fallback


def identity_link(value, article=False):
    link = allowed_link(value, '')
    if not link:
        return ''
    url = urlsplit(link)
    is_article = bool(re.fullmatch(r'/(?:a|b|video/watch)/[^/]+/?', url.path))
    if url.hostname not in ('dzen.ru', 'www.dzen.ru') or url.fragment or url.path in ('', '/'):
        return ''
    if article != is_article or (not article and url.path.startswith('/profile/editor')):
        return ''
    return urlunsplit(('https', 'dzen.ru', url.path.rstrip('/'), '', ''))


def context_id(raw, text, author):
    article = identity_link(raw.get('articleUrl'), article=True)
    profile = identity_link(raw.get('authorUrl'))
    parents = raw.get('parentPath')
    if not article or not profile or not author or not isinstance(parents, list) or len(parents) > 12:
        return ''
    path = []
    for parent in parents:
        link = identity_link(parent.get('authorUrl'))
        body = normalize(parent.get('text'))
        if not link or not body:
            return ''
        path.append([link, body])
    payload = json.dumps([article, profile, path, text], ensure_ascii=False, separators=(',', ':'))
    return 'context_ui_' + hashlib.sha256(payload.encode('utf-8')).hexdigest()


def make_comment(raw, source):
    text = normalize(raw.get('text'))
    author = normalize(raw.get('author'))[:180]
    if not text or len(text) > 6000:
        return None
    external = str(raw.get('commentId') or '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,180}', external):
        external = ''
    href = allowed_link(raw.get('href'), source)
    article = normalize(raw.get('articleTitle'))[:500]
    article_url = identity_link(raw.get('articleUrl'), article=True)
    if not external:
        external = context_id(raw, text, author)
        if external:
            href = article_url
    stamp = str(raw.get('absoluteTime') or '')
    if not external and author and article_url and re.fullmatch(r'\d{4}-\d{2}-\d{2}T[0-9:+.Z-]+', stamp):
        identity = '\n'.join((article_url, stamp, author.casefold(), text))
        external = 'context_' + hashlib.sha256(identity.encode('utf-8')).hexdigest()
    legacy = raw.get('legacy')
    if isinstance(legacy, dict):
        old = {'author': normalize(legacy.get('author'))[:180], 'articleTitle': normalize(legacy.get('articleTitle'))[:500],
               'href': allowed_link(legacy.get('href'), source)}
        if not external:
            author, article, href = old['author'], old['articleTitle'], old['href']
    else:
        old = None
    item = {'commentId': external, 'text': text, 'author': author, 'articleTitle': article,
            'href': href, 'createdLabel': normalize(raw.get('createdLabel'))[:140],
            'isOwn': raw.get('isOwn') is True, 'canReply': raw.get('canReply') is True and bool(external and author)}
    if external and old is not None:
        item['legacy'] = old
    return item


def identity(item):
    return 'id:' + item['commentId'] if item['commentId'] else 'text:' + hashlib.sha256('\n'.join((item['author'].casefold(), item['text'], item['articleTitle'], item['href'])).encode('utf-8')).hexdigest()


def same_target(a, b):
    return bool(a['commentId'] and a['commentId'] == b['commentId'] and normalize(a['author']).casefold() == normalize(b['author']).casefold() and normalize(a['text']) == normalize(b['text']))


class AgentError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Hub:
    def __init__(self, cfg):
        self.cfg = cfg
        self.opener = build_opener(NoRedirect())

    def post(self, route, body):
        payload = json.dumps({'agentId': self.cfg['agentId'], **body}, ensure_ascii=False).encode('utf-8')
        request = Request(self.cfg['hub'] + '/hooks/dzen/' + route, data=payload,
                          headers={'Authorization': 'Bearer ' + self.cfg['token'], 'Content-Type': 'application/json'}, method='POST')
        try:
            with self.opener.open(request, timeout=20) as response:
                return json.loads(response.read(2 * 1024 * 1024))
        except HTTPError as error:
            raise AgentError('hub_http_' + str(error.code)) from None
        except (URLError, OSError, ValueError):
            raise AgentError('hub_unavailable') from None

    async def call(self, route, body):
        return await asyncio.to_thread(self.post, route, body)

    async def report(self, task_id, outcome, **fields):
        for attempt in range(3):
            try:
                return await self.call('result', {'taskId': task_id, 'outcome': outcome, **fields})
            except AgentError as error:
                if error.code not in ('hub_unavailable', 'hub_http_500', 'hub_http_502', 'hub_http_503', 'hub_http_504') or attempt == 2:
                    raise
                await asyncio.sleep(5)


CARD_DATA = r"""(card, index=0) => {
  const visible = el => Boolean(el && el.getClientRects().length);
  const cardSelector = 'div[class*="editor--comment__block"]';
  const postSelector = '[class*="comments-page__groupByPost"]';
  const nodeSelector = '[class*="comments-page__commentNode"],[class*="root-comment__commentNode"]';
  const textSelector = 'p[aria-label="Текст комментария"]';
  const nameSelector = 'a[class*="comment__nameLink"]';
  const local = (owner, selector) => Array.from(owner.querySelectorAll(selector)).filter(el => el.closest(cardSelector) === owner && visible(el));
  if (!visible(card)) return null;
  const p = local(card, textSelector)[0];
  if (!p || !p.getClientRects().length) return null;
  const lines = (card.innerText || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
  const marker = lines.findIndex(x => /^(подписчик|автор)$/i.test(x));
  const legacyAuthor = marker > 0 ? lines[marker-1] : '';
  const names = local(card, nameSelector);
  const name = names.length === 1 ? names[0] : null;
  const author = name?.innerText || legacyAuthor;
  const visibleAuthorBadge = Boolean(name && local(card, 'span,div').some(el => !p.contains(el) && el.children.length === 0 && /^автор$/i.test(String(el.innerText || '').trim())));
  const created = marker >= 0 ? lines[marker+1] || '' : '';
  const hrefs = local(card, 'a[href]').map(a => a.href);
  const oldDirect = hrefs.find(x => /#comment_[A-Za-z0-9_-]+$/.test(x));
  const direct = local(card, 'a[href]').filter(a => !p.contains(a)).map(a => a.href).find(x => { try { const u = new URL(x); return u.protocol === 'https:' && ['dzen.ru','www.dzen.ru'].includes(u.hostname) && /^\/(a|b|video\/watch)\//.test(u.pathname) && /^#comment_[A-Za-z0-9_-]+(?:&[^#]*)?$/.test(u.hash); } catch { return false; } });
  const fromLink = direct?.match(/#comment_([A-Za-z0-9_-]+)(?:&[^#]*)?$/)?.[1] || '';
  const nodeId = card.getAttribute('data-comment-id') || card.id.match(/^comment_([A-Za-z0-9_-]+)$/)?.[1] || '';
  const row = card.closest('[class*="comments-page__commentNode"]') || card;
  const articleLink = (a, pattern) => { try { const u = new URL(a.href); return u.protocol === 'https:' && ['dzen.ru','www.dzen.ru'].includes(u.hostname) && pattern.test(u.pathname) && !u.hash; } catch { return false; } };
  const legacyArticle = Array.from(row.querySelectorAll('a[href]')).find(a => articleLink(a, /^\/(a|video\/watch)\//));
  const group = card.closest(postSelector);
  const links = group ? Array.from(group.querySelectorAll('a[href]')).filter(a => visible(a) && a.closest(postSelector) === group && !a.closest(nodeSelector) && String(a.innerText || '').trim() && articleLink(a, /^\/(a|b|video\/watch)\/[^/]+\/?$/)) : [];
  const articles = new Map(links.map(a => [new URL(a.href).pathname.replace(/\/$/, ''), a]));
  const article = articles.size === 1 ? articles.values().next().value : null;
  const parentPath = [];
  let complete = Boolean(group && card.parentElement?.matches(nodeSelector));
  for (let el = card.parentElement?.parentElement; el && el !== group; el = el.parentElement) {
    if (!el.matches(nodeSelector)) continue;
    const parents = Array.from(el.children).filter(child => child.matches(cardSelector) && visible(child));
    if (parents.length !== 1) { complete = false; break; }
    const parentNames = local(parents[0], nameSelector);
    const parentTexts = local(parents[0], textSelector);
    if (parentNames.length !== 1 || parentTexts.length !== 1) { complete = false; break; }
    parentPath.unshift({authorUrl: parentNames[0].href, text: parentTexts[0].innerText});
  }
  const time = local(card, 'time[datetime]')[0];
  const buttons = local(card, 'button[data-testid="reply-button"]').filter(x => !x.disabled);
  return {index, text:p.innerText || '', author, createdLabel:created, isOwn:visibleAuthorBadge || (marker>=0 && /^автор$/i.test(lines[marker])), commentId:nodeId || fromLink,
    href:direct || location.href, articleTitle:article?.innerText || legacyArticle?.innerText || '', articleUrl:article?.href || legacyArticle?.href || '', authorUrl:name?.href || '', parentPath:complete && article ? parentPath : null,
    absoluteTime:time?.getAttribute('datetime') || '', canReply:buttons.length===1,
    legacy:{author:legacyAuthor, articleTitle:legacyArticle?.innerText || '', href:oldDirect || location.href}};
}"""
EXTRACT = '(selector) => Array.from(document.querySelectorAll(selector)).map(' + CARD_DATA + ').filter(Boolean)'


class Studio:
    def __init__(self, page, source):
        self.page, self.source = page, source

    async def assert_access(self, response=None):
        status = response.status if response else 200
        if status in (403, 429):
            raise AgentError('blocked')
        url = urlsplit(self.page.url)
        if 'captcha' in url.path.lower() or 'challenge' in url.path.lower():
            raise AgentError('blocked')
        if url.hostname not in HOSTS or status == 401 or '/comments' not in url.path:
            raise AgentError('login_required')
        configured = urlsplit(self.source)
        if url.hostname != configured.hostname or url.path.rstrip('/') != configured.path.rstrip('/'):
            raise AgentError('interface_changed')
        if status >= 400:
            raise AgentError('unavailable')
        if await self.page.get_by_role('heading', name=re.compile(r'^(Подтвердите, что вы не робот|Доступ ограничен|Слишком много запросов)$', re.I)).count():
            raise AgentError('blocked')

    async def open(self):
        response = await self.page.goto(self.source, wait_until='domcontentloaded', timeout=60000)
        await self.assert_access(response)
        try:
            await self.page.locator(CARD).first.wait_for(state='visible', timeout=12000)
        except Exception:
            await self.assert_access()
            empty = self.page.get_by_text(re.compile(r'^(Нет комментариев|Комментариев пока нет|Нет комментариев без ответа|Нет неотвеч[её]нных комментариев|Нет новых комментариев)$', re.I))
            for i in range(min(await empty.count(), 10)):
                if await empty.nth(i).is_visible():
                    return
            raise AgentError('interface_changed') from None

    async def verified_filter(self):
        # The current Studio uses answer=notReply and the «Неотвеченные» chip.
        # Both the actual URL and a visible filter control must agree; a comment
        # containing the same words, an open menu option or a redirect is not proof.
        selected = unanswered_parameter(self.source)
        if not selected or unanswered_parameter(self.page.url) != selected:
            return False
        if not same_studio_channel(self.source, self.page.url):
            return False
        filters = self.page.get_by_text(re.compile(r'^(Без ответа|Неотвеч[её]нные)$', re.I))
        for i in range(min(await filters.count(), 10)):
            label = filters.nth(i)
            if await label.is_visible() and await label.evaluate(r"""(el) => {
              if (el.closest('[class*="editor--comment__block"], [class*="comments-page__commentNode"], [role="menu"], [role="listbox"], [role="dialog"], [role="option"], [role="menuitem"]')) return false;
              const control = el.closest('button,[role="button"],[role="checkbox"],[role="radio"],[role="tab"],[class*="filter" i],[class*="chip" i],[data-testid*="filter" i]');
              return Boolean(control && control.getClientRects().length && control.getAttribute('aria-pressed') !== 'false' && control.getAttribute('aria-selected') !== 'false' && control.getAttribute('aria-checked') !== 'false');
            }"""):
                return True
        return False

    async def snapshots(self):
        await self.assert_access()
        raw = await self.page.evaluate(EXTRACT, CARD)
        results = []
        for value in raw:
            item = make_comment(value, self.source)
            if item:
                results.append((value['index'], item))
        return results

    async def scroll(self):
        # Only the normal visible comments page/container, never hidden data.
        await self.page.evaluate("""() => { const root=document.scrollingElement; if(root) root.scrollTop += 1800; for(const e of document.querySelectorAll('[class*="comments-page__"]')) { if(e.getClientRects().length && e.scrollHeight>e.clientHeight+100) e.scrollTop+=1800; } }""")
        await self.page.wait_for_timeout(500)

    async def scan(self):
        await self.open()
        verified = await self.verified_filter()
        found, stagnant = {}, 0
        for step in range(MAX_SCROLLS + 1):
            batch = await self.snapshots()
            if verified and not await self.verified_filter():
                verified = False
            keys = [identity(item) for _, item in batch]
            before = len(found)
            for _, item in batch:
                key = identity(item)
                if keys.count(key) > 1 or (key in found and not found[key]['canReply']):
                    item['canReply'] = False
                found[key] = item
            stagnant = stagnant + 1 if before == len(found) else 0
            if stagnant >= 2 or len(found) >= 250 or step == MAX_SCROLLS:
                break
            await self.scroll()
        # Stay below both the default reverse-proxy body limit and the Hub's
        # JSON limit, including non-ASCII text. Later scans can pick up more.
        items, size = [], 0
        for item in list(found.values())[:250]:
            size += len(json.dumps(item, ensure_ascii=False).encode('utf-8')) + 8
            if size > 750000:
                break
            items.append(item)
        return items, verified

    async def target(self, item):
        await self.open()
        if not await self.verified_filter():
            raise AgentError('interface_changed')
        contextual = item['commentId'].startswith('context_')
        matched = None
        for step in range(MAX_SCROLLS + 1):
            candidates = [(ix, value) for ix, value in await self.snapshots() if same_target(value, item)]
            if not await self.verified_filter():
                raise AgentError('interface_changed')
            if len(candidates) > 1:
                raise AgentError('ambiguous')
            if candidates:
                index, value = candidates[0]
                if not value['canReply'] or value['isOwn']:
                    raise AgentError('not_found')
                candidate = await self.page.locator(CARD).nth(index).element_handle(timeout=5000)
                if candidate is None:
                    raise AgentError('not_found')
                if not contextual:
                    return candidate
                if matched is not None and not await matched.evaluate('(el, other) => el.isConnected && el === other', candidate):
                    raise AgentError('ambiguous')
                matched = candidate
            elif matched is not None:
                # A virtualised or replaced card cannot be proven unique later.
                raise AgentError('ambiguous')
            if step < MAX_SCROLLS:
                await self.scroll()
        if matched is not None:
            return matched
        raise AgentError('not_found')

    async def prepare(self, item):
        card = await self.target(item)
        await card.scroll_into_view_if_needed(timeout=5000)
        # Refetch the identity after scrolling, then pin actual DOM elements.
        candidates = [(ix, value) for ix, value in await self.snapshots() if same_target(value, item)]
        if len(candidates) != 1 or not candidates[0][1]['canReply']:
            raise AgentError('ambiguous')
        current = await self.page.locator(CARD).nth(candidates[0][0]).element_handle(timeout=5000)
        if current is None or not await card.evaluate('(el, other) => el.isConnected && el === other', current):
            raise AgentError('ambiguous')
        raw = await card.evaluate(CARD_DATA)
        pinned = make_comment(raw, self.source) if raw else None
        if not pinned or not same_target(pinned, item) or pinned['isOwn'] or not pinned['canReply']:
            raise AgentError('ambiguous')
        buttons = await card.query_selector_all(REPLY)
        if len(buttons) != 1 or not await buttons[0].is_visible():
            raise AgentError('interface_changed')
        thread = await card.query_selector('xpath=ancestor::div[contains(@class,"comments-page__commentNode")][1]')
        if thread is None:
            raise AgentError('interface_changed')
        before = await self.own_replies(thread)
        if item['commentId'].startswith('context_') and before:
            raise AgentError('ambiguous')
        await buttons[0].click(timeout=7000)
        await card.wait_for_selector(COMPOSER, state='visible', timeout=5000)
        composers = await card.query_selector_all(COMPOSER)
        if len(composers) != 1:
            raise AgentError('ambiguous')
        composer = composers[0]
        prefix = await composer.input_value()
        if prefix.strip():
            mention = normalize(prefix).casefold().rstrip(',:').strip().lstrip('@')
            if mention != normalize(item['author']).casefold():
                raise AgentError('ambiguous')
        reply = item['reply']
        value = reply if not prefix or normalize(reply).casefold().startswith(normalize(prefix).casefold()) else prefix + reply
        expected = {normalize(value), normalize(reply)}
        if any(x in expected for x in before):
            raise AgentError('ambiguous')
        await composer.fill(value)
        form = await composer.query_selector('xpath=ancestor::*[@data-testid="comment-form-container"][1]')
        sends = await form.query_selector_all(SEND) if form else []
        if len(sends) != 1 or not await sends[0].is_visible() or not await sends[0].is_enabled():
            raise AgentError('interface_changed')
        return sends[0], thread, expected, before, card

    async def assert_pinned(self, card, send, item):
        if not await card.evaluate('(el, send) => el.isConnected && el.contains(send) && send.isConnected', send):
            raise AgentError('ambiguous')
        raw = await card.evaluate(CARD_DATA)
        pinned = make_comment(raw, self.source) if raw else None
        if not pinned or not same_target(pinned, item) or pinned['isOwn']:
            raise AgentError('ambiguous')

    @staticmethod
    async def own_replies(thread):
        # Verify only the original thread and the channel's visible author label.
        values = await thread.evaluate("""(el) => {
          if (!el.isConnected) throw Error('detached thread');
          return Array.from(el.querySelectorAll('div[class*="editor--comment__block"]')).filter(card => {
            const lines=(card.innerText||'').split(/\\n+/).map(x=>x.trim());
            const marker=lines.findIndex(x=>/^(подписчик|автор)$/i.test(x));
            return card.getClientRects().length && marker>0 && /^автор$/i.test(lines[marker]);
          }).map(card=>card.querySelector('p[aria-label="Текст комментария"]')?.innerText||'');
        }""")
        return [normalize(x) for x in values]

    async def publish(self, task, hub):
        begun = False
        try:
            if task['comment'].get('commentId', '').startswith('context_') and task['comment'].get('approval') != 'manual':
                raise AgentError('ambiguous')
            send, thread, expected, before, card = await self.prepare(task['comment'])
            await self.assert_access()
            if not await self.verified_filter():
                raise AgentError('interface_changed')
            await self.assert_pinned(card, send, task['comment'])
            # The server must acknowledge the irreversible step exactly once.
            if (await hub.call('begin', {'taskId': task['id']})).get('ok') is not True:
                raise AgentError('not_sent')
            begun = True
            if not await send.evaluate('(el) => el.isConnected'):
                return 'uncertain', 'uncertain'
            await self.assert_pinned(card, send, task['comment'])
            await send.click(timeout=7000)
            for _ in range(20):
                await self.assert_access()
                try:
                    after = await self.own_replies(thread)
                    if any(after.count(x) > before.count(x) for x in expected):
                        return 'sent', ''
                except Exception:
                    pass
                await self.page.wait_for_timeout(500)
            return 'uncertain', 'uncertain'
        except AgentError as error:
            return ('uncertain' if begun else 'not_sent'), error.code
        except Exception:
            return ('uncertain' if begun else 'not_sent'), ('uncertain' if begun else 'interface_changed')


def config_path():
    root = Path(os.getenv('LOCALAPPDATA') or (Path.home() / '.local/share')) / 'BoykovServicesDzen'
    root.mkdir(parents=True, exist_ok=True)
    if os.name != 'nt':
        root.chmod(0o700)
    return root / 'config.json'


def configure(path):
    old = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    hub = hub_url(input('Адрес Boykov Services [https://boykov-services.ru]: ').strip() or 'https://boykov-services.ru')
    source = unanswered_studio_url(input('Ссылка на комментарии Студии (выберите «Неотвеченные»): '))
    token = getpass.getpass('Ключ агента (ввод скрыт): ').strip()
    if len(token) < 32:
        raise ValueError('Ключ должен содержать не менее 32 символов.')
    data = {'hub': hub, 'studioUrl': source, 'token': token, 'agentId': old.get('agentId') or str(uuid.uuid4())}
    if old and not same_studio_channel(old['studioUrl'], source):
        raise ValueError('Уже настроен другой канал. Используйте отдельный профиль после согласованной смены канала.')
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(data, stream, ensure_ascii=False)
    os.replace(temporary, path)
    print('DZEN_AGENT_CONFIGURED=OK')


async def run(cfg, profile, login=False, headless=False):
    from playwright.async_api import async_playwright
    hub = Hub(cfg)
    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(str(profile), headless=headless and not login, viewport={'width':1440,'height':1000}, locale='ru-RU')
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            studio = Studio(page, cfg['studioUrl'])
            if login:
                await page.goto(cfg['studioUrl'], wait_until='domcontentloaded')
                await asyncio.to_thread(input, 'Войдите в Дзен вручную и откройте комментарии канала. Затем нажмите Enter здесь: ')
                await studio.open()
                print('DZEN_STUDIO_LOGIN=OK')
                return
            status = 'starting'
            print('DZEN_AGENT_STARTED')
            while True:
                polled = await hub.call('poll', {'studioUrl':cfg['studioUrl'], 'status':status})
                task = polled.get('task')
                if not task:
                    await asyncio.sleep(max(5, min(60, int(polled.get('waitSeconds', 15)))))
                    continue
                if task['kind'] == 'scan':
                    try:
                        comments, verified = await studio.scan()
                        await hub.report(task['id'], 'success', comments=comments, verifiedUnanswered=verified)
                        status = 'ready'
                        bound = sum(bool(item['commentId']) for item in comments)
                        ready = sum(bool(item['canReply'] and not item['isOwn']) for item in comments) if verified else 0
                        print(f'DZEN_SCAN=OK COUNT={len(comments)} VERIFIED_FILTER={int(verified)} BOUND={bound} READY={ready}')
                    except AgentError as error:
                        if error.code.startswith('hub_'):
                            raise
                        await hub.report(task['id'], 'error', code=error.code)
                        print('DZEN_SCAN_STOPPED=' + error.code)
                        return
                    except Exception:
                        await hub.report(task['id'], 'error', code='interface_changed')
                        print('DZEN_SCAN_STOPPED=interface_changed')
                        return
                elif task['kind'] == 'publish':
                    outcome, code = await studio.publish(task, hub)
                    await hub.report(task['id'], outcome, code=code)
                    print('DZEN_PUBLISH=' + outcome)
                    if outcome == 'uncertain' or code in ('blocked', 'login_required', 'interface_changed'):
                        print('DZEN_AGENT_STOPPED=CHECK_STUDIO')
                        return
                else:
                    raise AgentError('unknown_task')
        finally:
            await context.close()


def main():
    parser = argparse.ArgumentParser(description='Boykov Services · агент комментариев Дзена')
    parser.add_argument('command', choices=('configure', 'login', 'run'))
    parser.add_argument('--headless', action='store_true', help='Фоновый режим только для уже авторизованного профиля')
    args = parser.parse_args()
    path = config_path()
    try:
        if args.command == 'configure':
            configure(path)
        else:
            if not path.is_file():
                raise ValueError('Сначала выполните configure.')
            config = json.loads(path.read_text(encoding='utf-8'))
            config['hub'] = hub_url(config['hub'])
            config['studioUrl'] = unanswered_studio_url(config['studioUrl'])
            asyncio.run(run(config, path.parent / 'browser-profile', args.command == 'login', args.headless))
    except KeyboardInterrupt:
        print('DZEN_AGENT_STOPPED')
    except (AgentError, ValueError) as error:
        print('DZEN_AGENT_ERROR=' + str(error), file=sys.stderr)
        return 1
    except Exception:
        # Never print a browser session, request headers or a potentially
        # sensitive traceback into logs.
        print('DZEN_AGENT_ERROR=CHECK_CONFIGURATION_AND_BROWSER', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
