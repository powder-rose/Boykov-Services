import unittest
from unittest.mock import AsyncMock, Mock

from agent import AgentError, Studio, make_comment, same_target, studio_url, hub_url, identity, unanswered_parameter, unanswered_studio_url, same_studio_channel

URL = 'https://dzen.ru/profile/editor/test/comments?comments_data=n_reply'
BASE = 'https://dzen.ru/profile/editor/id/test/comments/'
CURRENT = BASE + '?answer=notReply'


class IdentityTests(unittest.TestCase):
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
        studio.prepare=AsyncMock(return_value=(send,thread,{'Спасибо!'},[]))
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
