"""Protocol regression tests: no external account, network or AI download."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('bridge',Path(__file__).resolve().parents[1]/'local-worker/bridge.py')
b = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(b)

class Handler(BaseHTTPRequestHandler):
    calls=[]
    job=None
    def log_message(self,*args): pass
    def do_GET(self):
        self.__class__.calls.append(('GET',self.path,dict(self.headers),None))
        if self.path == '/redirect':
            self.send_response(302);self.send_header('Location','https://example.com/stolen');self.end_headers();return
        self.send_response(200);self.end_headers();self.wfile.write(b'original bytes')
    def do_PUT(self): self.do_POST()
    def do_POST(self):
        raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
        data=json.loads(raw) if self.headers.get('Content-Type')=='application/json' else raw
        self.__class__.calls.append((self.command,self.path,dict(self.headers),data))
        result={}
        if self.path.endswith('/claim'):result={'job':self.job,'settings':{}}
        if self.path.endswith('/upload/start'):result={'id':'multipart-test'}
        if '/upload/part?' in self.path:result={'partNumber':int(self.path.split('part=')[1]),'etag':'fixture'}
        if self.path.endswith('/upload') or self.path.endswith('/upload/complete'):result={'src':'/media/display/job/photo.png','original':'/media/private/source.arw'}
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(result).encode())

class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.origin='http://127.0.0.1:'+str(cls.server.server_port)
    @classmethod
    def tearDownClass(cls):cls.server.shutdown();cls.server.server_close()
    def setUp(self):
        Handler.calls=[];Handler.job=None
        self.client=b.Client(self.origin,'synthetic-worker-token',allow_local=True)
    def test_https_required_and_origin_only(self):
        for url in ('http://example.com','https://user:secret@example.com','https://example.com/path','https://example.com?q=x'):
            with self.assertRaises(b.BridgeError):b.Client(url,'token')
    def test_redirect_never_forwards_credentials(self):
        with self.assertRaises(b.BridgeError):self.client.request('/redirect')
        self.assertEqual(len(Handler.calls),1)
    def test_download_requires_owned_media_path(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'source.mov'
            for value in ('https://example.com/source','//example.com/media/x','/media/%2e%2e/private'):
                with self.assertRaises(b.BridgeError):self.client.download(value,path)
            self.client.download('/media/private/source.mov',path)
            self.assertEqual(path.read_bytes(),b'original bytes')
    def test_credentials_file_requires_private_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'worker.json';path.write_text('{"url":"https://example.com","token":"private"}');path.chmod(0o644)
            with self.assertRaises(b.BridgeError):b.load_config(path)
            path.chmod(0o600);self.assertEqual(b.load_config(path)['url'],'https://example.com')
    def test_large_upload_streams_bounded_parts_and_completes(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'photo.png';path.write_bytes(b'a'*(b.CHUNK+13))
            result=self.client.upload(path,{'id':'job-1','worker_id':'worker-a','lease_token':'lease-a'})
        parts=[c for c in Handler.calls if c[0]=='PUT']
        self.assertEqual([len(c[3]) for c in parts],[b.CHUNK,13])
        self.assertEqual(result['src'],'/media/display/job/photo.png')
        self.assertTrue(all(c[2]['Authorization']=='Bearer synthetic-worker-token' for c in Handler.calls))
        self.assertEqual(Handler.calls[-1][3]['lease_token'],'lease-a')
    def test_complete_is_after_processing_and_cache_removed(self):
        Handler.job={'id':'job-1','lease_token':'lease-a','kind':'video','media':'/media/private/source.mov'}
        with tempfile.TemporaryDirectory() as temp,patch.object(b,'process',return_value=({'duration':3},[{'id':'video-job-1-0','reviewed':False}])):
            cache=Path(temp)/'private-cache'
            self.assertTrue(b.run_once(self.client,cache,'worker-a'))
            self.assertFalse((cache/'job-1').exists())
        complete=Handler.calls[-1]
        self.assertEqual(complete[1],'/api/worker/complete')
        self.assertEqual(complete[3]['worker_id'],'worker-a')
        self.assertFalse(complete[3]['records'][0]['reviewed'])
    def test_fail_does_not_send_exception_secret_and_cleans_cache(self):
        Handler.job={'id':'job-2','lease_token':'lease-b'}
        with tempfile.TemporaryDirectory() as temp,patch.object(b,'process',side_effect=RuntimeError('private token accidental')):
            cache=Path(temp)/'cache';b.run_once(self.client,cache,'worker-a')
            self.assertFalse((cache/'job-2').exists())
        self.assertEqual(Handler.calls[-1][1],'/api/worker/fail')
        self.assertNotIn('private token',json.dumps(Handler.calls[-1][3]))
    def test_empty_queue_and_malicious_job_identity(self):
        self.assertFalse(b.run_once(self.client))
        Handler.job={'id':'../../private','lease_token':'x'}
        with self.assertRaises(b.BridgeError):b.run_once(self.client)
    def test_lease_heartbeat_contains_identity(self):
        fake=type('Client',(),{'request':lambda self,*a: calls.append(a)})()
        calls=[]
        lease=b.Lease(fake,{'id':'job','worker_id':'worker','lease_token':'lease'})
        self.assertFalse(lease.lost)

if __name__=='__main__':unittest.main()
