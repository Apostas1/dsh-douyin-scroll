"""Offline tests: signer/HTTP/browser processes are mocks, never real credentials."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import _home


class PortabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='douyin-python-test-')
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {'DOUYIN_HOME': self.tmp.name})
        self.env.start()
        self.addCleanup(self.env.stop)
        Path(self.tmp.name, 'douyin_cookie.txt').write_text('fixture-only-not-a-credential')
        # No dependency installation is needed: all HTTP responses are mocked.
        httpx = types.ModuleType('httpx')
        httpx.HTTPError = type('HTTPError', (Exception,), {})
        httpx.get = lambda *a, **k: self.fail('unexpected HTTP call')
        with patch.dict(sys.modules, {'httpx': httpx}):
            spec = importlib.util.spec_from_file_location('api_comments_test', ROOT / 'tools/api-comments.py')
            self.mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.mod)

    def test_node_override_and_path_lookup(self):
        with patch.dict(os.environ, {'DOUYIN_NODE': '/portable/node'}):
            self.assertEqual(_home.node_bin(), '/portable/node')
        with patch.dict(os.environ, {'DOUYIN_NODE': ''}), patch.object(_home.shutil, 'which', return_value='/path/node'):
            self.assertEqual(_home.node_bin(), '/path/node')

    def test_python_venv_or_current_interpreter(self):
        self.assertEqual(_home.python_bin(), sys.executable)
        venv = Path(self.tmp.name, '.venv', 'Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        venv.parent.mkdir(parents=True); venv.touch()
        self.assertEqual(_home.python_bin(), str(venv))

    def test_utf8_even_when_console_defaults_to_ascii(self):
        result = subprocess.run([sys.executable, '-c', 'import _home; print("中文 🐟")'],
                                cwd=ROOT / 'tools', capture_output=True,
                                env={**os.environ, 'PYTHONIOENCODING': 'ascii'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.decode('utf-8').strip(), '中文 🐟')

    def test_missing_node_is_a_structured_signer_failure(self):
        with patch.object(self.mod.subprocess, 'run', side_effect=FileNotFoundError()):
            self.assertIn('签名进程不可用', self.mod.sign('/read')['err'])

    def test_signer_nonzero_or_invalid_json_never_succeeds(self):
        for code, output in [(1, b'{"signedUrl":"/read"}'), (0, b'[]'), (0, b'{invalid}')]:
            with patch.object(self.mod.subprocess, 'run', return_value=types.SimpleNamespace(returncode=code, stdout=output, stderr=b'')):
                self.assertIn('err', self.mod.sign('/read'))

    def test_signed_empty_response_falls_back_to_browser(self):
        response = types.SimpleNamespace(raise_for_status=lambda: None, json=lambda: (_ for _ in ()).throw(ValueError('empty')))
        fallback = types.SimpleNamespace(returncode=0, stdout=b'{"status_code":0,"comments":[]}', stderr=b'')
        with patch.object(self.mod, 'sign', return_value={'signedUrl': '/read'}), patch.object(self.mod.httpx, 'get', return_value=response) as get, patch.object(self.mod.subprocess, 'run', return_value=fallback) as run:
            result, mode = self.mod.page_fetch('/read')
            self.assertEqual(mode, 'cdp')
            self.assertEqual(result['status_code'], 0)
            self.assertFalse(get.call_args.kwargs['follow_redirects'])
            self.assertEqual(run.call_args.args[0][1], self.mod.CDP_FETCH)

    def test_foreign_signed_url_is_never_sent_cookies(self):
        fallback = types.SimpleNamespace(returncode=0, stdout=b'{"status_code":0}', stderr=b'')
        for url in ['https://evil.invalid/read', 'http://www.douyin.com/read']:
            with patch.object(self.mod, 'sign', return_value={'signedUrl': url}), patch.object(self.mod.httpx, 'get') as get, patch.object(self.mod.subprocess, 'run', return_value=fallback):
                self.assertEqual(self.mod.page_fetch('/read')[1], 'cdp')
                get.assert_not_called()

    def test_failed_browser_fallback_is_not_an_empty_success(self):
        with patch.object(self.mod, 'sign', return_value={'err': 'missing SDK'}), patch.object(self.mod.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1, stdout=b'{"status_code":0}', stderr=b'locked')):
            with self.assertRaisesRegex(RuntimeError, '签名和兜底都不通'):
                self.mod.page_fetch('/read')

    def test_legacy_reply_without_confirm_does_not_start_node(self):
        draft = Path(self.tmp.name, 'text.txt'); draft.write_text('draft only', encoding='utf-8')
        result = subprocess.run([sys.executable, str(ROOT / 'tools/api-reply.py'), 'reply', '123', '456', str(draft)],
                                capture_output=True, env={**os.environ, 'DOUYIN_NODE': '/missing/node'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['needsConfirm'], True)


if __name__ == '__main__':
    unittest.main()
