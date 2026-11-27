from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from agent import AgentError, config_path, hub_url, public_author_link, run, same_studio_channel, unanswered_studio_url, write_config

TRANSIENT = {'hub_unavailable', 'hub_http_500', 'hub_http_502', 'hub_http_503', 'hub_http_504'}


def root():
    directory = config_path().parent
    for name in ('home', 'cache', 'config'):
        (directory / name).mkdir(mode=0o700, exist_ok=True)
    return directory


@contextmanager
def session_lock(directory):
    with (directory / 'session.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('DZEN_SERVER_PROFILE_IN_USE') from None
        yield


def validated_config(data):
    profile = public_author_link(data.get('publicAuthorUrl'))
    if not profile or not isinstance(data.get('token'), str) or len(data['token']) < 32:
        raise ValueError('DZEN_SERVER_CONFIGURATION_INVALID')
    return {**data, 'hub':hub_url(data['hub']), 'studioUrl':unanswered_studio_url(data['studioUrl']), 'publicAuthorUrl':profile}


def configure_stdin(directory):
    incoming = validated_config(json.loads(sys.stdin.read(16384)))
    path = config_path()
    old = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    if old and (old['hub'] != incoming['hub'] or not same_studio_channel(old['studioUrl'],incoming['studioUrl'])):
        raise ValueError('DZEN_SERVER_CHANNEL_CHANGED')
    incoming['agentId'] = old.get('agentId') or str(uuid.uuid4())
    write_config(path, incoming)
    print('DZEN_SERVER_CONFIGURED=OK')


def hold(directory, reason):
    (directory / 'needs-review').write_text(reason+'\n',encoding='utf-8')
    print('DZEN_SERVER_NEEDS_REVIEW='+reason)


async def supervise(directory, cfg, runner=run, sleeper=asyncio.sleep):
    failures = 0
    announced = False
    while True:
        marker = directory / 'needs-review'
        if marker.exists() or not (directory / 'profile-ready').is_file():
            if not announced:
                print('DZEN_SERVER_WAITING_REVIEW')
                announced = True
            await sleeper(5)
            continue
        announced = False
        try:
            await runner(cfg, directory / 'browser-profile', headless=True, sandbox=True)
        except AgentError as error:
            if error.code not in TRANSIENT:
                hold(directory,error.code)
                continue
            failures += 1
            print('DZEN_SERVER_HUB_RETRY='+error.code)
            await sleeper(min(300,30*2**min(failures-1,4)))
        except Exception:
            failures += 1
            if failures >= 3:
                hold(directory,'BROWSER_ERROR')
                failures = 0
            else:
                print('DZEN_SERVER_BROWSER_RETRY')
                await sleeper(30*failures)
        else:
            hold(directory,'CHECK_STUDIO')
            failures = 0


def wait_display(process, display):
    for _ in range(30):
        if process.poll() is not None:
            break
        if subprocess.run(['xdpyinfo','-display',display],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(0.2)
    raise RuntimeError('DZEN_SERVER_DISPLAY_FAILED')


def login(directory,cfg):
    processes = []
    display = ':99'
    with tempfile.TemporaryDirectory(prefix='dzen-login-') as temp:
        password = Path(temp) / 'vnc-password'
        print('Задайте временный пароль удалённого экрана (не пароль Дзена).')
        subprocess.run(['x11vnc','-storepasswd',str(password)],check=True)
        password.chmod(0o600)
        try:
            os.environ['DISPLAY'] = display
            Path('/tmp/.X11-unix').mkdir(mode=0o1777,exist_ok=True)
            xvfb = subprocess.Popen(['Xvfb',display,'-screen','0','1440x1000x24','-nolisten','tcp'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            processes.append(xvfb)
            wait_display(xvfb,display)
            processes.append(subprocess.Popen(['x11vnc','-display',display,'-localhost','-rfbport','5900','-rfbauth',str(password),'-forever','-shared','-quiet'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            processes.append(subprocess.Popen(['websockify','--web=/usr/share/novnc','0.0.0.0:6080','127.0.0.1:5900'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            time.sleep(0.6)
            if any(process.poll() is not None for process in processes):
                raise RuntimeError('DZEN_SERVER_LOGIN_SCREEN_FAILED')
            print('DZEN_LOGIN_SCREEN=http://127.0.0.1:6080/vnc.html (only through SSH tunnel)')
            asyncio.run(run(cfg,directory/'browser-profile',login=True,sandbox=True))
            (directory/'profile-ready').touch(mode=0o600)
            print('DZEN_SERVER_LOGIN=OK')
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


async def daemon(directory,cfg):
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM,signal.SIGINT):
        loop.add_signal_handler(sig,task.cancel)
    try:
        await supervise(directory,cfg)
    except asyncio.CancelledError:
        print('DZEN_SERVER_STOPPED')


async def self_test():
    from playwright.async_api import async_playwright
    try:
        async with async_playwright() as playwright:
            browser=await playwright.chromium.launch(headless=True,chromium_sandbox=True)
            try:
                page=await browser.new_page()
                await page.set_content('<title>Dzen agent self-test</title>')
                if await page.title() != 'Dzen agent self-test':
                    raise RuntimeError('DZEN_SERVER_BROWSER_SELF_TEST_FAILED')
            finally:
                await browser.close()
    except Exception:
        raise RuntimeError('DZEN_SERVER_BROWSER_SANDBOX_FAILED') from None
    print('DZEN_SERVER_BROWSER=OK')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('mode',choices=('configure-stdin','login','run','resume','status','self-test'))
    args=parser.parse_args()
    directory=root()
    if args.mode == 'self-test':
        asyncio.run(self_test())
        return 0
    if args.mode == 'status':
        print('DZEN_SERVER_PROFILE_READY='+str(int((directory/'profile-ready').is_file())))
        print('DZEN_SERVER_HOLD='+str(int((directory/'needs-review').is_file())))
        return 0
    if args.mode == 'resume':
        if not (directory/'profile-ready').is_file():
            raise RuntimeError('DZEN_SERVER_LOGIN_REQUIRED')
        if input('Проверены опубликованные ответы и доступ к Студии? Введите YES: ').strip() != 'YES':
            return 1
        (directory/'needs-review').unlink(missing_ok=True)
        print('DZEN_SERVER_RESUME=OK')
        return 0
    with session_lock(directory):
        if args.mode == 'configure-stdin':
            configure_stdin(directory)
        else:
            cfg=validated_config(json.loads(config_path().read_text(encoding='utf-8')))
            if args.mode == 'login':
                login(directory,cfg)
            else:
                asyncio.run(daemon(directory,cfg))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError,RuntimeError,AgentError) as error:
        print('DZEN_SERVER_ERROR='+str(error),file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        print('DZEN_SERVER_ERROR=CHECK_CONFIGURATION_AND_BROWSER',file=sys.stderr)
        raise SystemExit(1)
