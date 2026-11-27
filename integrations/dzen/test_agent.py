import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from agent import AgentError, Studio, make_comment, same_target, studio_url, hub_url, identity, unanswered_parameter, unanswered_studio_url, same_studio_channel, allowed_link, EXTRACT, CARD, article_title, author_name, reply_value, all_comments_url, appeared_reply, same_root, recent_reply_label
from agent import PUBLIC_EXTRACT, PUBLIC_CARD, PUBLIC_EXPAND, PUBLIC_CARD_DATA, public_reply_proof, public_author_link, configure_public_author, public_preview_matches, public_expansion_candidates, public_reply_status

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
        studio.prepare=AsyncMock(return_value=(send,thread,{'Спасибо!'},[],AsyncMock(),{}))
        studio.assert_pinned=AsyncMock()
        studio.own_replies=AsyncMock(return_value=['Спасибо!'])
        studio.confirm_all_comments=AsyncMock(return_value=False)
        studio.confirm_public_comments=AsyncMock(return_value=False)
        hub=AsyncMock();hub.call.return_value={'ok':True}
        return studio,hub,send

    async def test_begin_before_click_and_confirm_only_new_reply(self):
        studio,hub,send=self.setup()
        outcome=await studio.publish({'id':'task','comment':{}},hub)
        self.assertEqual(outcome,('sent',''))
        hub.call.assert_awaited_once_with('begin',{'taskId':'task'})
        send.click.assert_awaited_once()
        studio.confirm_all_comments.assert_not_awaited()
        studio.confirm_public_comments.assert_not_awaited()

    async def test_missing_filtered_thread_is_confirmed_read_only_in_all_comments(self):
        studio,hub,send=self.setup()
        studio.own_replies.side_effect=RuntimeError('detached thread')
        studio.confirm_all_comments.return_value=True
        outcome=await studio.publish({'id':'task','comment':{}},hub)
        self.assertEqual(outcome,('sent',''))
        studio.confirm_all_comments.assert_awaited_once_with({}, {'Спасибо!'}, [], {})
        studio.confirm_public_comments.assert_not_awaited()
        send.click.assert_awaited_once()
        hub.call.assert_awaited_once()

    async def test_missing_proof_stays_uncertain_without_second_click(self):
        studio,hub,send=self.setup()
        studio.own_replies.return_value=[]
        self.assertEqual(await studio.publish({'id':'task','comment':{}},hub),('uncertain','uncertain'))
        studio.confirm_all_comments.assert_awaited_once()
        studio.confirm_public_comments.assert_awaited_once_with({'Спасибо!'}, [], {})
        send.click.assert_awaited_once()
        hub.call.assert_awaited_once()

    async def test_public_article_confirmation_does_not_repeat_send(self):
        studio,hub,send=self.setup()
        studio.own_replies.return_value=[]
        studio.confirm_public_comments.return_value=True
        self.assertEqual(await studio.publish({'id':'task','comment':{}},hub),('sent',''))
        studio.confirm_public_comments.assert_awaited_once_with({'Спасибо!'}, [], {})
        hub.call.assert_awaited_once()
        send.click.assert_awaited_once()

    async def test_restricted_studio_does_not_trigger_public_fallback(self):
        studio,hub,send=self.setup()
        studio.own_replies.return_value=[]
        studio.confirm_all_comments.side_effect=AgentError('blocked')
        self.assertEqual(await studio.publish({'id':'task','comment':{}},hub),('uncertain','blocked'))
        studio.confirm_public_comments.assert_not_awaited()
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
    async def test_scan_continues_through_loaded_cards_until_scroll_stops(self):
        studio=Studio(AsyncMock(),CURRENT)
        studio.open=AsyncMock()
        studio.verified_filter=AsyncMock(return_value=True)
        first={'commentId':'first','author':'Читатель','text':'Первый','canReply':True,'isOwn':False}
        later={'commentId':'later','author':'Читатель','text':'Поздний','canReply':True,'isOwn':False}
        studio.snapshots=AsyncMock(side_effect=[[(0,first)]]*6+[[(0,first),(1,later)]]*5)
        studio.scroll=AsyncMock(side_effect=[True]*6+[False]*4)
        comments,verified=await studio.scan()
        self.assertTrue(verified)
        self.assertEqual([item['commentId'] for item in comments],['first','later'])
        self.assertEqual(studio.scroll.await_count,10)

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


class ConfirmationTests(unittest.IsolatedAsyncioTestCase):
    def setup(self):
        page=Mock();page.url=BASE;page.goto=AsyncMock();page.evaluate=AsyncMock()
        page.locator.return_value.first.wait_for=AsyncMock()
        studio=Studio(page,CURRENT)
        studio.assert_access=AsyncMock();studio.all_view_access=AsyncMock(return_value=True);studio.scroll=AsyncMock()
        studio.pinned_confirmation_thread=AsyncMock(return_value=AsyncMock())
        studio.own_replies=AsyncMock(return_value=['Спасибо!'])
        studio.expand_confirmation_thread=AsyncMock(return_value=False)
        raw={'index':0,'author':'Читатель','authorUrl':'https://dzen.ru/id/test','articleTitle':'Статья','articleUrl':'https://dzen.ru/a/test-post','parentPath':[],'text':'Вопрос','canReply':True,'href':BASE}
        return studio,page,raw,make_comment(raw,CURRENT)

    async def test_unfiltered_same_thread_and_new_author_reply_confirm_publication(self):
        studio,page,raw,item=self.setup()
        page.evaluate.return_value=[raw]
        self.assertTrue(await studio.confirm_all_comments(item,{'Спасибо!'},[],raw))
        page.goto.assert_awaited_once_with(BASE,wait_until='domcontentloaded',timeout=25000)
        studio.own_replies.assert_awaited_once_with(studio.pinned_confirmation_thread.return_value,confirmed_only=True,fresh_only=True,author_url='')
        studio.expand_confirmation_thread.assert_not_awaited()
        self.assertEqual(all_comments_url(CURRENT),BASE)
        self.assertFalse(appeared_reply(['Спасибо!'],['Спасибо!'],{'Спасибо!'}))
        self.assertFalse(appeared_reply([],['Не тот ответ'],{'Спасибо!'}))

    async def test_old_identical_reply_after_reopening_does_not_confirm(self):
        thread=AsyncMock()
        thread.evaluate.return_value=[{'text':'Старый ответ','age':'1 д','nameAge':'1 д','ownConfirmed':True},{'text':'Новый ответ','age':'','nameAge':'автор · 1\u00a0м','ownConfirmed':True}]
        self.assertEqual(await Studio.own_replies(thread,confirmed_only=True,fresh_only=True),['Новый ответ'])
        self.assertTrue(recent_reply_label('только что'))
        self.assertTrue(recent_reply_label('1 м'))
        self.assertFalse(recent_reply_label('3 м'))
        self.assertFalse(recent_reply_label(''))

    async def test_studio_video_reply_matches_channel_profile_without_author_badge(self):
        thread=AsyncMock()
        own={'text':'Новый ответ','headerAge':'1 мин','authorUrl':'https://dzen.ru/example-channel','ownConfirmed':False,'isOwn':False}
        thread.evaluate.return_value=[own,{**own,'text':'Чужой ответ','authorUrl':'https://dzen.ru/other-channel'},{**own,'text':'Старый ответ','headerAge':'58 мин'}]
        self.assertEqual(await Studio.own_replies(thread,confirmed_only=True,fresh_only=True,author_url='https://dzen.ru/example-channel'),['Новый ответ'])
        self.assertEqual(await Studio.own_replies(thread,confirmed_only=True,fresh_only=True),[])
        self.assertEqual(await Studio.own_replies(thread,author_url='https://dzen.ru/example-channel'),['Новый ответ','Старый ответ'])

    async def test_duplicate_or_unrelated_target_cannot_confirm(self):
        studio,page,raw,item=self.setup()
        page.evaluate.return_value=[raw,{**raw,'index':1}]
        self.assertFalse(await studio.confirm_all_comments(item,{'Спасибо!'},[],raw))
        studio.own_replies.assert_not_awaited()
        page.evaluate.return_value=[{**raw,'articleUrl':'https://dzen.ru/a/other'}]
        self.assertFalse(await studio.confirm_all_comments(item,{'Спасибо!'},[],raw))
        studio.own_replies.assert_not_awaited()

    async def test_collapsed_root_can_be_expanded_before_exact_nested_proof(self):
        studio,page,root,_=self.setup()
        raw={**root,'index':1,'author':'Другой читатель','authorUrl':'https://dzen.ru/id/nested','text':'Уточнение','parentPath':[{'authorUrl':root['authorUrl'],'text':root['text']}]}
        item=make_comment(raw,CURRENT)
        self.assertTrue(same_root(root,raw))
        page.evaluate.side_effect=[[root],[root,raw]]
        studio.expand_confirmation_thread.return_value=True
        self.assertTrue(await studio.confirm_all_comments(item,{'Спасибо!'},[],raw))
        studio.expand_confirmation_thread.assert_awaited_once()
        studio.pinned_confirmation_thread.assert_any_await(root,root=raw)
        studio.pinned_confirmation_thread.assert_any_await(raw,item=item)

    async def test_reply_without_matching_author_badge_is_not_confirmation(self):
        studio,page,raw,item=self.setup()
        page.evaluate.return_value=[raw]
        studio.own_replies.return_value=[]
        self.assertFalse(await studio.confirm_all_comments(item,{'Спасибо!'},[],raw))


class PublicConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.author='https://dzen.ru/example-channel'
        self.root={'index':0,'rootIndex':0,'isRoot':True,'isChild':False,'author':'Читатель','authorUrl':'https://dzen.ru/user/reader','text':'Вопрос','age':'29 мая'}
        self.context={**self.root,'parentPath':[],'articleUrl':'https://dzen.ru/a/test-post','publishedText':'Читатель, Спасибо!','publishedMention':'Читатель,'}
        self.reply={'index':1,'rootIndex':0,'isRoot':False,'isChild':True,'author':'Канал','authorUrl':self.author,'text':'Читатель, Спасибо!','age':'1 мин'}
        self.expected={'Читатель, Спасибо!','Спасибо!'}

    def proof(self, values, context=None, before=()):
        return public_reply_proof(values, context or self.context, self.author, self.expected, before)

    def test_exact_author_profile_fresh_reply_and_same_public_thread(self):
        self.assertTrue(self.proof([self.root,self.reply]))
        for changes in ({'authorUrl':'https://dzen.ru/other'}, {'rootIndex':2}, {'age':'14 мин'}, {'age':''}, {'isChild':False}, {'text':'Спасибо!'}, {'text':'Читатель, Другой ответ'}):
            self.assertFalse(self.proof([self.root,{**self.reply,**changes}]),changes)
        self.assertFalse(self.proof([self.root,self.reply], before=['Спасибо!']))
        self.assertFalse(self.proof([self.root,self.reply,{**self.reply,'index':2}]))
        self.assertFalse(self.proof([self.root,self.reply,{**self.root,'index':2,'rootIndex':2}]))
        self.assertFalse(self.proof([self.root]))
        self.assertFalse(self.proof([{**self.root,'authorUrl':'https://dzen.ru/user/another'},self.reply]))

    def test_nested_reply_requires_full_branch_and_unambiguous_mention(self):
        target={**self.root,'index':2,'isRoot':False,'isChild':True,'author':'Другой читатель','authorUrl':'https://dzen.ru/user/child','text':'Уточнение'}
        context={**self.context,**target,'parentPath':[self.root],'publishedText':'Другой читатель, Спасибо!','publishedMention':'Другой читатель,'}
        reply={**self.reply,'text':context['publishedText']}
        self.expected.add(context['publishedText'])
        self.assertTrue(self.proof([self.root,target,reply],context))
        self.assertFalse(self.proof([self.root,reply],context))
        self.assertFalse(self.proof([self.root,target,reply],{**context,'publishedMention':''}))
        self.assertFalse(self.proof([self.root,target,reply,{**target,'index':3,'authorUrl':'https://dzen.ru/user/duplicate','text':'Другой вопрос'}],context))

    def test_public_preview_is_only_used_to_select_expansion_not_confirm(self):
        full={**self.root,'text':'Длинный исходный комментарий о работе на производстве.'}
        preview={**full,'text':'Длинный исходный комментарий о работе... ещё','clamped':True}
        context={**self.context,**full}
        self.assertTrue(public_preview_matches(preview,full))
        self.assertFalse(public_preview_matches({**preview,'clamped':False},full))
        self.assertFalse(public_preview_matches({**preview,'authorUrl':'https://dzen.ru/user/other'},full))
        self.assertFalse(self.proof([preview,self.reply],context))
        self.assertEqual(public_reply_status([preview,self.reply],context,self.author,self.expected,[]),'PUBLIC_TEXT_COLLAPSED')
        self.assertFalse(self.proof([full,{**preview,'index':2,'rootIndex':2},self.reply],context))
        self.assertTrue(self.proof([full,self.reply],context))

    def test_profile_setting_preserves_private_existing_config(self):
        original={'hub':'https://example.test','studioUrl':CURRENT,'agentId':'id','token':'fixture-token'}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'config.json'
            path.write_text(json.dumps(original),encoding='utf-8')
            configure_public_author(path,'https://www.dzen.ru/example-channel/')
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')),{**original,'publicAuthorUrl':self.author})
            for value in ('https://dzen.ru/a/article','https://other.test/name','https://dzen.ru/profile/editor/test','http://dzen.ru/name'):
                self.assertFalse(public_author_link(value))
                with self.assertRaises(ValueError):
                    configure_public_author(path,value)

    def test_expansion_label_does_not_match_reply_or_collapse(self):
        for text in ('4 ответа','1 ответ','Показать 7 ответов'):
            self.assertTrue(PUBLIC_EXPAND.fullmatch(text))
        for text in ('Ответить','Отправить','Свернуть ответы','4 лайка'):
            self.assertFalse(PUBLIC_EXPAND.fullmatch(text))


class PublicNavigationTests(unittest.IsolatedAsyncioTestCase):
    def setup(self):
        fixture=PublicConfirmationTests()
        fixture.setUp()
        page=Mock();page.url=fixture.context['articleUrl'];page.goto=AsyncMock(return_value=Mock(status=200));page.evaluate=AsyncMock();page.wait_for_timeout=AsyncMock()
        page.get_by_role.return_value.count=AsyncMock(return_value=0)
        page.close=AsyncMock()
        studio=Studio(Mock(),CURRENT,fixture.author)
        studio.page.context.new_page=AsyncMock(return_value=page)
        return studio,page,fixture

    async def test_opens_only_original_article_expands_root_and_closes_confirmation_tab(self):
        studio,page,fixture=self.setup()
        page.evaluate.side_effect=[[fixture.root],[fixture.root,fixture.reply]]
        studio.expand_public_root=AsyncMock(return_value=True)
        self.assertTrue(await studio.confirm_public_comments(fixture.expected, [], fixture.context))
        page.goto.assert_awaited_once_with(fixture.context['articleUrl'],wait_until='domcontentloaded',timeout=12000)
        studio.expand_public_root.assert_awaited_once_with(page,fixture.root,fixture.context)
        page.close.assert_awaited_once()

    async def test_expands_both_long_root_and_nested_target_before_confirmation(self):
        studio,page,fixture=self.setup()
        root={**fixture.root,'text':'Длинный исходный комментарий с подробным описанием ситуации.'}
        root_preview={**root,'text':'Длинный исходный комментарий с подробным... ещё','clamped':True}
        target={**root,'index':2,'isRoot':False,'isChild':True,'author':'Другой читатель','authorUrl':'https://dzen.ru/user/child','text':'Длинное уточнение от другого читателя о его опыте.'}
        target_preview={**target,'text':'Длинное уточнение от другого читателя... ещё','clamped':True}
        context={**fixture.context,**target,'parentPath':[root],'publishedText':'Другой читатель, Спасибо!','publishedMention':'Другой читатель,'}
        reply={**fixture.reply,'text':context['publishedText']}
        unrelated={**target_preview,'index':3,'author':'Третий','authorUrl':'https://dzen.ru/user/unrelated'}
        page.evaluate.side_effect=[[root_preview],[root,target_preview,unrelated,reply],[root,target,unrelated,reply]]
        studio.expand_public_text=AsyncMock(return_value=True)
        self.assertEqual(public_expansion_candidates([root,target_preview,unrelated,reply],context,fixture.author),[target_preview])
        self.assertTrue(await studio.confirm_public_comments({context['publishedText']},[],context))
        self.assertEqual(studio.expand_public_text.await_count,2)
        studio.expand_public_text.assert_any_await(page,root_preview)
        studio.expand_public_text.assert_any_await(page,target_preview)
        page.close.assert_awaited_once()

    async def test_redirect_and_access_restriction_never_confirm(self):
        studio,page,fixture=self.setup()
        page.url='https://dzen.ru/a/another'
        self.assertFalse(await studio.confirm_public_comments(fixture.expected, [], fixture.context))
        page.evaluate.assert_not_awaited()
        page.close.assert_awaited_once()
        studio,page,fixture=self.setup()
        page.goto.return_value.status=429
        with self.assertRaisesRegex(AgentError,'blocked'):
            await studio.confirm_public_comments(fixture.expected, [], fixture.context)
        page.evaluate.assert_not_awaited()
        page.close.assert_awaited_once()

    async def test_unconfigured_author_does_not_open_article(self):
        studio,page,fixture=self.setup()
        studio.public_author_url=''
        self.assertFalse(await studio.confirm_public_comments(fixture.expected, [], fixture.context))
        studio.page.context.new_page.assert_not_awaited()


class DomFixtureTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_more_control_expands_only_the_matching_reader_text(self):
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
                await page.set_content('''<div class="comments2--comment__wrapper-2Z comments2--comment__root-_K">
                    <div class="comments2--comment__comment-2P">
                      <div><a class="comments2--comment-header__nameLink-38" href="https://dzen.ru/user/reader">Читатель</a> <span>1 мин</span></div>
                      <div class="comments2--comment-content__wrapper-32"><div class="comments2--comment-text__block-2s"><span>Длинный исходный комментарий...</span> <button data-test="read-more">ещё</button></div></div>
                      <button>Ответить</button><button>Показать все</button>
                    </div>
                  </div>''')
                await page.locator('[data-test="read-more"]').evaluate("button => button.addEventListener('click', () => {button.parentElement.textContent = 'Длинный исходный комментарий о производстве.'})")
                values=await page.evaluate(PUBLIC_EXTRACT,PUBLIC_CARD)
                self.assertTrue(values[0]['clamped'])
                self.assertEqual(values[0]['age'],'1 мин')
                self.assertTrue(await Studio.expand_public_text(page,values[0]))
                raw=await page.locator(PUBLIC_CARD).evaluate(PUBLIC_CARD_DATA)
                self.assertFalse(raw['clamped'])
                self.assertEqual(raw['text'],'Длинный исходный комментарий о производстве.')
                self.assertTrue(await page.get_by_role('button',name='Показать все').is_visible())
            finally:
                await browser.close()

    async def test_public_article_expanded_root_and_channel_reply(self):
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
                await page.set_content('''<div class="comments2--comment__wrapper-2Z comments2--comment__root-_K"><div class="comments2--comment__content-1L"><div class="comments2--comment__right-3j">
                  <div class="comments2--comment__comment-2P"><div><div><a class="comments2--comment-header__nameLink-38" href="https://dzen.ru/user/reader">Читатель</a></div><div>29 мая</div></div><div class="comments2--comment-text__block-2s">Вопрос</div><button>Ответить</button><button>Свернуть ответы</button></div>
                  <div class="comments2--comment__childComments-2H"><div class="comments2--comment__wrapper-2Z"><div class="comments2--comment__content-1L"><div class="comments2--comment__right-3j">
                    <div class="comments2--comment__comment-2P"><div><div><a class="comments2--comment-header__nameLink-38" href="https://dzen.ru/example-channel">Канал</a></div><div>1 мин</div></div><div class="comments2--comment-text__block-2s"><span>Читатель, </span><span>Спасибо!</span></div><button>Ответить</button></div>
                  </div></div></div></div>
                </div></div></div>''')
                raw=await page.evaluate(PUBLIC_EXTRACT,PUBLIC_CARD)
                self.assertEqual(len(raw),2)
                self.assertTrue(raw[0]['isRoot'])
                self.assertTrue(raw[1]['isChild'])
                self.assertEqual(raw[1]['rootIndex'],0)
                self.assertEqual(raw[1]['age'],'1 мин')
                context={**raw[0],'parentPath':[],'publishedText':'Читатель, Спасибо!','publishedMention':'Читатель,'}
                self.assertTrue(public_reply_proof(raw,context,'https://dzen.ru/example-channel',{'Читатель, Спасибо!'},[]))
                await page.locator('[class*="comment__childComments-"]').evaluate('(el) => el.style.display="none"')
                raw=await page.evaluate(PUBLIC_EXTRACT,PUBLIC_CARD)
                self.assertFalse(public_reply_proof(raw,context,'https://dzen.ru/example-channel',{'Читатель, Спасибо!'},[]))
            finally:
                await browser.close()

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
                        <div class="editor--comment__block-1t"><a class="editor--comment__nameLink-1r" href="https://dzen.ru/id/own">Канал<br>автор<br>1&nbsp;м</a><p aria-label="Текст комментария">Спасибо!</p></div>
                      </div></div>
                    </div>
                  </div>
                </div>''')
                raw=await page.evaluate(EXTRACT,CARD)
                self.assertEqual(len(raw),3)
                self.assertEqual(raw[0]['parentPath'],[])
                self.assertEqual(raw[1]['parentPath'],[{'authorUrl':'https://dzen.ru/id/parent','text':'Вопрос'}])
                self.assertEqual(article_title(raw[1]['articleTitle']),'Тестовая статья')
                self.assertEqual(raw[1]['author'],'Другой читатель')
                self.assertEqual(make_comment(raw[0],CURRENT)['author'],'Читатель')
                self.assertTrue(all(make_comment(value,CURRENT)['canReply'] for value in raw[:2]))
                self.assertTrue(raw[2]['ownConfirmed'])
                thread=await page.locator('[class*="comments-page__commentNode"]').first.element_handle()
                self.assertEqual(await Studio.own_replies(thread,confirmed_only=True),['Спасибо!'])
                self.assertEqual(await Studio.own_replies(thread,confirmed_only=True,fresh_only=True),['Спасибо!'])
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
