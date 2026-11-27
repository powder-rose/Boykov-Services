import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

try:
    from server.server_agent import supervise, session_lock, validated_config
    from agent import AgentError
except ImportError:
    supervise = None


@unittest.skipIf(supervise is None, 'Linux server supervisor only')
class ServerAgentTests(unittest.IsolatedAsyncioTestCase):
    def test_profile_lock_prevents_concurrent_browser_instances(self):
        with tempfile.TemporaryDirectory() as directory:
            with session_lock(Path(directory)):
                with self.assertRaisesRegex(RuntimeError,'PROFILE_IN_USE'):
                    with session_lock(Path(directory)):
                        pass

    async def test_safe_stop_holds_and_does_not_restart_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'profile-ready').touch()
            runner=AsyncMock(return_value=None)
            sleeper=AsyncMock(side_effect=asyncio.CancelledError)
            with self.assertRaises(asyncio.CancelledError):
                await supervise(root,{},runner,sleeper)
            self.assertTrue((root/'needs-review').is_file())
            runner.assert_awaited_once_with({},root/'browser-profile',headless=True,sandbox=True)

    async def test_transient_hub_failure_retries_but_access_error_stays_on_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'profile-ready').touch()
            runner=AsyncMock(side_effect=[AgentError('hub_unavailable'),AgentError('hub_http_403')])
            sleeper=AsyncMock(side_effect=[None,asyncio.CancelledError])
            with self.assertRaises(asyncio.CancelledError):
                await supervise(root,{},runner,sleeper)
            self.assertEqual(runner.await_count,2)
            self.assertEqual((root/'needs-review').read_text().strip(),'hub_http_403')

    async def test_restart_with_hold_or_no_login_does_not_start_browser(self):
        for marker in (None,'needs-review'):
            with tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                if marker:
                    (root/'profile-ready').touch();(root/marker).touch()
                runner=AsyncMock()
                with self.assertRaises(asyncio.CancelledError):
                    await supervise(root,{},runner,AsyncMock(side_effect=asyncio.CancelledError))
                runner.assert_not_awaited()
