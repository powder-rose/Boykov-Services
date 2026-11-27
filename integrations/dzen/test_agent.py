import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from agent import AgentError, Studio, make_comment, same_target, studio_url, hub_url, identity, unanswered_parameter, unanswered_studio_url, same_studio_channel, allowed_link, EXTRACT, CARD, article_title, author_name, reply_value

URL = 'https://dzen.ru/profile/editor/test/comments?comments_data=n_reply'
BASE = 'https://dzen.ru/profile/editor/id/test/comments/'
CURRENT = BASE + '?answer=notReply'


class IdentityTests(unittest.TestCase):
    def test_author_link_metadata_does_not_corrupt_reply_mention(self):
        self.assertEqual(author_name('Геннадий Д\nподписчик\n1\u00a0д'),'Геннадий Д')
        self.assertEqual(author_name('Геннадий Д\nподписчик · 2 ч'),'Геннадий Д')
        self.assertEqual(author_name('Смирнов\n9 ч'),'Смирнов')
        self.assertEqual(author_name('Анна\nавтор\nсегодня'),'Анна')
        self.assertEqual(author_name('Мастер 4 м'),'Мастер 4 м')
        clean=author_name('Геннадий Д\nподписчик\n1\u00a0д')
        self.assertEqual(reply_value('Геннадий Д, ',clean,'Спасибо за вопрос.'),'Геннадий Д, Спасибо за вопрос.')
        self.assertEqual(reply_value('Геннадий Д, ',clean,'Геннадий Д, спасибо.'),'Геннадий Д, спасибо.')
        with self.assertRaisesRegex(AgentError,'ambiguous'):
            reply_value('Другой читатель, ',clean,'Спасибо.')

    def test_post_title_excludes_visible_relative_age_but_preserves_actual_title(self):
        title='Техническая статья о кабеле длиной 4 м'
        self.assertEqual(article_title(title+'\n4\u00a0м'),title)
        self.assertEqual(article_title(title+'\n5 ч'),title)
        self.assertEqual(article_title(title),title)
        self.assertEqual(article_title('Длинное название\nвторая строка'),'Длинное название вторая строка')

    def test_context_binding_is_independent_of_relative_time_and_scoped_to_article_profile_and_parent(self):
        raw={'author':'Читатель','authorUrl':'https://dzen.ru/id/test-profile','articleTitle':'Статья','articleUrl':'https://dzen.ru/a/test-article','parentPath':[],'text':'Вопрос','canReply':True,'href':CURRENT,'legacy':{'author':'','articleTitle':'','href':BASE}}
        bound=make_comment(raw,CURRENT)
        self.assertTrue(bound['commentId'].startswith('context_ui_'))
        self.assertTrue(bound['canReply'])
        self.assertEqual(bound['href'],'https://dzen.ru/a/test-article')
        self.assertEqual(bound['legacy']['href'],BASE)
        self.assertTrue(same_target(bound,make_comment({**raw,'createdLabel':'10 ч'},CURRENT)))
        for changes in ({'articleUrl':'https://dzen.ru/a/different'}, {'authorUrl':'https://dzen.ru/id/different'}, {'parentPath':[{'authorUrl':'https://dzen.ru/id/parent','text':'Родитель'}]}):
            self.assertFalse(same_target(bound,make_comment({**raw,**changes},CURRENT)))
        for changes in ({'authorUrl':''}, {'articleUrl':''}, {'parentPath':None}, {'parentPath':[{'authorUrl':'','text':'Родитель'}]}):
            self.assertFalse(make_comment({**raw,**changes},CURRENT)['canReply'])
        self.assertEqual(allowed_link('https://dzen.ru/a/test?share_to=link#comment_3434268054&comments_data=n_new',''),'https://dzen.ru/a/test#comment_3434268054')

    def test_current_filter_and_existing_saved_url(self):
        self.assertEqual(studio_url(CURRENT+'&tracking=x'), CURRENT)
        self.assertEqual(unanswered_studio_url(BASE), CURRENT)
        self.assertEqual(unanswered_studio_url(URL), URL)
        self.assertTrue(same_studio_channel(BASE, CURRENT))
        self.assertFalse(same_studio_channel(BASE, CURRENT.replace('/test/', '/another/')))
        for conflicting in (CURRENT+'&answer=reply', CURRENT+'&comments_data=n_reply', BASE+'?answer=reply'):
            self.assertIsNone(unanswered_parameter(conflicting))
            self.assertEqual(studio_url(conflicting), BASE)

    def test_source_scope_and_link_normalization(self):
        self.assertEqual(studio_url(URL+'#ignored'),URL)
        with self.assertRaises(ValueError): studio_url('https://dzen.ru.example.invalid/comments')
        with self.assertRaises(ValueError): studio_url('http://dzen.ru/comments')
        with self.assertRaises(ValueError): hub_url('https://example.invalid/other')
        self.assertEqual(hub_url('https://boykov-services.ru/'),'https://boykov-services.ru')

    def test_stable_id_or_context_required_for_posting(self):
        raw={'author':'Читатель','text':'Как  оформить?','canReply':True,'href':URL}
        missing=make_comment(raw,URL)
        self.assertFalse(missing['canReply'])
        first=make_comment({**raw,'commentId':'c123'},URL)
        self.assertTrue(first['canReply'])
        self.assertTrue(same_target(first,make_comment({**raw,'commentId':'c123','createdLabel':'Вчера'},URL)))
        self.assertFalse(same_target(first,make_comment({**raw,'commentId':'c123','author':'Другой'},URL)))
        self.assertFalse(same_target(first,make_comment({**raw,'commentId':'c124'},URL)))
        contextual=make_comment({**raw,'articleUrl':'https://dzen.ru/a/test','absoluteTime':'2026-11-25T08:30:00Z'},URL)
        self.assertTrue(contextual['canReply'])
        self.assertTrue(contextual['commentId'].startswith('context_'))
        self.assertFalse(make_comment({**raw,'articleUrl':'https://dzen.ru/a/test','absoluteTime':'сегодня'},URL)['canReply'])
        self.assertEqual(identity(first),'id:c123')


class PublishingTests(unittest.IsolatedAsyncioTestCase):
    def setup(self):
        studio=Studio(AsyncMock(),URL)
        studio.assert_access=AsyncMock()
        studio.verified_filter=AsyncMock(return_value=True)
        send=AsyncMock();send.evaluate.return_value=True
        thread=AsyncMock()
        studio.prepare=AsyncMock(return_value=(send,thread,{'Спасибо!'},[],AsyncMock()))
        studio.assert_pinned=AsyncMock()
        studio.own_replies=AsyncMock(return_value=['Спасибо!'])
        hub=AsyncMock();hub.call.return_value={'ok':True}
        return studio,hub,send

    async def test_begin_before_click_and_confirm_only_new_reply(self):
        studio,hub,send=self.setup()
        outcome=await studio.publish({'id':'task','comment':{}},hub)
        self.assertEqual(outcome,('sent',''))
        hub.call.assert_awaited_once_with('begin',{'taskId':'task'})
        send.click.assert_awaited_once()

    async def test_hub_rejects_begin_no_click(self):
        studio,hub,send=self.setup()
        hub.call.side_effect=AgentError('hub_http_409')
        outcome=await studio.publish({'id':'task','comment':{}},hub)
        self.assertEqual(outcome,('not_sent','hub_http_409'))
        send.click.assert_not_awaited()

    async def test_uncertain_click_never_retries(self):
        studio,hub,send=self.setup()
        send.click.side_effect=RuntimeError('timeout')
        outcome=await studio.publish({'id':'task','comment':{}},hub)
        self.assertEqual(outcome,('uncertain','uncertain'))
        send.click.assert_awaited_once()

    async def test_detached_button_no_click(self):
        studio,hub,send=self.setup()
        send.evaluate.return_value=False
        self.assertEqual(await studio.publish({'id':'task','comment':{}},hub),('uncertain','uncertain'))
        send.click.assert_not_awaited()

    async def test_filter_changed_before_begin_no_publication(self):
        studio,hub,send=self.setup()
        studio.verified_filter.return_value=False
        self.assertEqual(await studio.publish({'id':'task','comment':{}},hub),('not_sent','interface_changed'))
        hub.call.assert_not_awaited()
        send.click.assert_not_awaited()

    async def test_contextual_auto_task_cannot_click(self):
        studio,hub,send=self.setup()
        task={'id':'task','comment':{'commentId':'context_ui_'+'a'*64,'approval':'auto'}}
        self.assertEqual(await studio.publish(task,hub),('not_sent','ambiguous'))
        studio.prepare.assert_not_awaited()
        hub.call.assert_not_awaited()
        send.click.assert_not_awaited()

    async def test_replaced_card_after_begin_refuses_click(self):
        studio,hub,send=self.setup()
        studio.assert_pinned.side_effect=[None,AgentError('ambiguous')]
        self.assertEqual(await studio.publish({'id':'task','comment':{}},hub),('uncertain','ambiguous'))
        hub.call.assert_awaited_once()
        send.click.assert_not_awaited()


class TargetTests(unittest.IsolatedAsyncioTestCase):
    async def test_contextual_target_detects_duplicate_in_later_snapshot(self):
        page=Mock()
        studio=Studio(page,CURRENT)
        studio.open=AsyncMock();studio.verified_filter=AsyncMock(return_value=True);studio.scroll=AsyncMock()
        item={'commentId':'context_ui_'+'a'*64,'text':'Вопрос','author':'Читатель','canReply':True,'isOwn':False}
        studio.snapshots=AsyncMock(side_effect=[[(0,item)],[(1,item)]])
        first=AsyncMock();first.evaluate.return_value=False
        locator=Mock();locator.element_handle=AsyncMock(side_effect=[first,AsyncMock()])
        page.locator.return_value.nth.return_value=locator
        with self.assertRaisesRegex(AgentError,'ambiguous'):
            await studio.target(item)
        self.assertEqual(studio.snapshots.await_count,2)


class DomFixtureTests(unittest.IsolatedAsyncioTestCase):
    async def test_observed_post_root_and_nested_structure(self):
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            self.skipTest('Playwright not installed')
        async with async_playwright() as pw:
            if not Path(pw.chromium.executable_path).is_file():
                self.skipTest('Chromium fixture runner not installed')
            browser=await pw.chromium.launch(headless=True)
            try:
                page=await browser.new_page()
                await page.set_content('''<div class="editor--comments-page__groupByPost-3D" data-testid="comment">
                  <a href="https://dzen.ru/a/test-post">Тестовая статья<br>4&nbsp;м</a>
                  <div class="editor--comments-page__commentsContainer-12">
                    <div class="editor--comments-page__commentNode-2f">
                      <div class="editor--comment__block-1t"><a class="editor--comment__nameLink-1r" href="https://dzen.ru/id/parent">Читатель<br>подписчик<br>1&nbsp;д</a><p aria-label="Текст комментария">Вопрос</p><button data-testid="reply-button">Ответить</button></div>
                      <div class="editor--root-comment__commentsContainer-Ep"><div class="editor--root-comment__commentNode-14">
                        <div class="editor--comment__block-1t"><a class="editor--comment__nameLink-1r" href="https://dzen.ru/id/child">Другой читатель</a><p aria-label="Текст комментария">Уточнение</p><button data-testid="reply-button">Ответить</button></div>
                      </div></div>
                    </div>
                  </div>
                </div>''')
                raw=await page.evaluate(EXTRACT,CARD)
                self.assertEqual(len(raw),2)
                self.assertEqual(raw[0]['parentPath'],[])
                self.assertEqual(raw[1]['parentPath'],[{'authorUrl':'https://dzen.ru/id/parent','text':'Вопрос'}])
                self.assertEqual(article_title(raw[1]['articleTitle']),'Тестовая статья')
                self.assertEqual(raw[1]['author'],'Другой читатель')
                self.assertEqual(make_comment(raw[0],CURRENT)['author'],'Читатель')
                self.assertTrue(all(make_comment(value,CURRENT)['canReply'] for value in raw))
            finally:
                await browser.close()


class FilterTests(unittest.IsolatedAsyncioTestCase):
    async def test_current_filter_needs_url_and_visible_control(self):
        page=Mock();page.url=CURRENT
        label=Mock();label.is_visible=AsyncMock(return_value=True);label.evaluate=AsyncMock(return_value=True)
        filters=Mock();filters.count=AsyncMock(return_value=1);filters.nth.return_value=label
        page.get_by_text.return_value=filters
        studio=Studio(page,CURRENT)
        self.assertTrue(await studio.verified_filter())
        self.assertTrue(page.get_by_text.call_args.args[0].fullmatch('Неотвеченные'))
        label.evaluate.return_value=False
        self.assertFalse(await studio.verified_filter())
        label.evaluate.return_value=True;label.is_visible.return_value=False
        self.assertFalse(await studio.verified_filter())
        label.is_visible.return_value=True;page.url=BASE
        self.assertFalse(await studio.verified_filter())
        page.url=CURRENT.replace('/test/', '/another/')
        self.assertFalse(await studio.verified_filter())


if __name__=='__main__':unittest.main()
