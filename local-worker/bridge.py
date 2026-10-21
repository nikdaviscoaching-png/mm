#!/usr/bin/env python3
"""Outbound-only Mac AI worker. Cloud inventory is the only inventory."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit, unquote
from urllib.request import Request, HTTPRedirectHandler, build_opener

CONFIG = Path.home() / 'Library/Application Support/Mineral Murals/worker.json'
CACHE = Path.home() / 'Library/Caches/Mineral Murals Cloud Worker'
CHUNK = 8 * 1024 * 1024

class BridgeError(RuntimeError): pass

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BridgeError('Server redirects are refused; check the saved website address.')

class Client:
    def __init__(self, base, token, *, allow_local=False):
        parts = urlsplit(base)
        local = parts.hostname in ('localhost', '127.0.0.1', '::1')
        if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ('', '/'):
            raise BridgeError('Use the website origin only, without a path or embedded password.')
        if parts.scheme != 'https' and not (allow_local and local and parts.scheme == 'http'):
            raise BridgeError('A secure HTTPS website address is required.')
        if not token or '\n' in token or '\r' in token: raise BridgeError('A worker pairing token is required.')
        self.base = base.rstrip('/')
        self.token = token
        self.opener = build_opener(NoRedirect())
    def request(self, path, data=None, headers=None, *, raw=False, method=None):
        if not path.startswith('/') or path.startswith('//') or urlsplit(path).netloc:
            raise BridgeError('The worker only contacts its paired website.')
        request_headers = {'Authorization': 'Bearer ' + self.token}
        request_headers.update(headers or {})
        if data is not None and not isinstance(data, bytes):
            data = json.dumps(data, allow_nan=False).encode()
            request_headers['Content-Type'] = 'application/json'
        req = Request(self.base + path, data=data, headers=request_headers, method=method)
        with self.opener.open(req, timeout=180) as response:
            if raw: return response.read()
            return json.loads(response.read().decode())
    def download(self, path, target):
        if not path.startswith('/media/') or '..' in unquote(path).split('/'):
            raise BridgeError('Invalid private recording path.')
        req = Request(self.base + path, headers={'Authorization': 'Bearer ' + self.token})
        with self.opener.open(req, timeout=180) as response, target.open('wb') as out:
            shutil.copyfileobj(response, out, CHUNK)
    def upload(self, path, job, *, role='display', original=None):
        path = Path(path)
        size = path.stat().st_size
        identity = {'job_id':job['id'],'worker_id':job['worker_id'],'lease_token':job.get('lease_token')}
        headers = {'X-Job-Id':job['id'],'X-Worker-Id':job['worker_id'],
                   'X-Lease-Token':job.get('lease_token',''),'X-Filename':path.name,
                   'X-Media-Role':role,'Content-Type':content_type(path)}
        if original: headers['X-Original'] = original
        if size <= CHUNK:
            result = self.request('/api/worker/upload',path.read_bytes(),headers)
        else:
            started = self.request('/api/worker/upload/start',{'name':path.name,
                'content_type':content_type(path),
                'role':role,'original':original, **identity})
            upload_id = started['id']
            from urllib.parse import urlencode
            parts = []
            with path.open('rb') as stream:
                number = 1
                while True:
                    block = stream.read(CHUNK)
                    if not block: break
                    parts.append(self.request('/api/worker/upload/part?'+urlencode({'id':upload_id,'part':number}),
                        block,{**headers,'X-HTTP-Method':'PUT'},method='PUT'))
                    number += 1
            result = self.request('/api/worker/upload/complete',{'id':upload_id,'parts':parts,**identity})
        if not isinstance(result, dict) or not result.get('src'):
            raise BridgeError('Website did not confirm the completed media upload.')
        return result

def content_type(path):
    return {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
            '.mp4':'video/mp4','.mov':'video/quicktime','.m4v':'video/mp4'}.get(Path(path).suffix.lower(),'application/octet-stream')

def channel_photos(client, path, job, original):
    """Separate channel copies; never modify a website image or original."""
    from PIL import Image, ImageOps
    path = Path(path)
    refs = {}
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert('RGB')
        for provider, maximum in [('etsy',8*1024*1024),('ebay',11*1024*1024)]:
            copy = image.copy()
            if copy.width+copy.height>14500:
                ratio=14500/(copy.width+copy.height)
                copy=copy.resize((max(1,int(copy.width*ratio)),max(1,int(copy.height*ratio))),Image.Resampling.LANCZOS)
            target=path.with_name(path.stem+'-'+provider+'.jpg')
            while True:
                copy.save(target,'JPEG',quality=95,subsampling=0,optimize=True,**({'icc_profile':image.info['icc_profile']} if image.info.get('icc_profile') else {}))
                if target.stat().st_size<=maximum:break
                copy=copy.resize((max(1,int(copy.width*.85)),max(1,int(copy.height*.85))),Image.Resampling.LANCZOS)
            refs['channel_'+provider]=client.upload(target,job,role='channel_'+provider,original=original)['src']
    return refs

def load_config(path=CONFIG):
    if not path.is_file(): raise BridgeError('Pair this Mac from Seller Hub → Settings → Local AI, then run the downloaded pairing file.')
    if path.stat().st_mode & 0o077: raise BridgeError('Pairing file must be private. Run chmod 600 on worker.json.')
    data = json.loads(path.read_text())
    return data

def modules():
    sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine'))
    import media
    import mineral_ai
    return media, mineral_ai

def new_record(text, identifier, settings, photos=None, video=None, extra=None):
    _, ai = modules()
    record = {**ai.extract_facts(text, settings), 'id': identifier, 'quantity':1,
        'status':'draft', 'reviewed':False, 'stock_verified':False, 'seller_work_confirmed':False,
        'source':'seller', 'original_transcript':text, 'photos':photos or [], 'video':video,
        'etsy_eligibility':settings.get('default_etsy_eligibility','seller_made_altered')}
    record.update(extra or {})
    record['title'] = record.get('material') or 'Untitled specimen'
    warnings = list(record.get('warnings', []))
    for field, message in [('material','Confirm material'),('price_cents','Confirm price'),('condition','Confirm condition')]:
        if not record.get(field): warnings.append(message)
    if not record['photos']: warnings.append('Add at least one photograph')
    record['warnings'] = list(dict.fromkeys(warnings))
    record['listings'] = ai.generate_listings(record, settings)
    record['description'] = record['listings']['website']['description']
    return record

def safe_id(value):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', str(value)): raise BridgeError('Invalid job identifier.')
    return str(value)

def process(client, job, settings, folder):
    media, ai = modules()
    source_url = job.get('media') or job.get('source')
    if isinstance(source_url, dict): source_url = source_url.get('original') or source_url.get('src')
    filename = job.get('filename') or urlsplit(source_url or '').path.rsplit('/',1)[-1]
    extension = Path(filename).suffix.lower()
    if not re.fullmatch(r'\.[a-z0-9]{1,8}', extension): raise BridgeError('Source filename needs its original extension.')
    original = folder / ('source' + extension)
    client.download(source_url, original)
    expected = job.get('sha256')
    if expected and hashlib.file_digest(original.open('rb'),'sha256').hexdigest() != expected:
        raise BridgeError('Original recording integrity check failed. Retry the upload.')
    kind = job.get('kind','video')
    out = folder / 'derived'
    out.mkdir(exist_ok=True)
    if kind == 'audio':
        result = media.transcribe(original, hints=settings.get('terminology',[]))
        return result, []
    if kind == 'image':
        from PIL import Image, ImageOps
        preview = out / 'display.png'
        conversion = media.convert_image(original, preview)
        # Strip camera EXIF and GPS without changing pixels, resolution or ICC.
        with Image.open(preview) as picture:
            picture = ImageOps.exif_transpose(picture)
            profile = picture.info.get('icc_profile')
            picture.save(out / 'clean.png','PNG', **({'icc_profile':profile} if profile else {}))
        uploaded = client.upload(out / 'clean.png', job, original=source_url)
        photo = {'src':uploaded['src'],'original':source_url,'metadata':{
            k:v for k,v in conversion.items() if k not in ('path','original')}}
        text = job.get('transcript','')
        record = new_record(text, 'image-'+job['id'], settings,[photo])
        photo.update(channel_photos(client,out / 'clean.png',job,source_url))
        return {'conversion':photo['metadata'],'photos':[photo],'photo':photo,'source':source_url}, [record] if text else []
    options = {**settings.get('video',{}), **job.get('options',{}), 'preserve_source':False}
    if kind == 'segment':
        video = job.get('video') or job.get('baseline',{}).get('video') or {}
        segment = media.process_segment(original,float(video['start']),float(video['end']),out,options)
        result = {'segments':[segment], 'duration':video.get('duration'), 'transcript':segment.get('transcription',{})}
    else:
        result = media.process_video(original,out,options)
    records = []
    for index, segment in enumerate(result.get('segments', [])):
        photos = []
        originals = segment.get('original_photos') or segment.get('photos',[])
        for offset, path in enumerate(segment.get('photos',[])):
            full = client.upload(originals[offset], job, role='original')
            # Original image uploads deliberately return a placeholder `src`;
            # only `original` points at the private, untouched image object.
            original_ref = full['original']
            display = client.upload(path,job,original=original_ref)
            photos.append({'src':display['src'],'original':original_ref,**channel_photos(client,path,job,original_ref)})
        clip = client.upload(segment['clip'],job,role='clip')['src'] if segment.get('clip') else None
        video = {'original':source_url,'start':segment['start'],'end':segment['end'],
                 'duration':result.get('duration'),'clip':clip,'job_id':job['id']}
        record = new_record(segment.get('transcript',''), job.get('item_id') if kind=='segment' else 'video-'+job['id']+'-'+str(index),
            settings,photos,video, {'warnings':segment.get('warnings',[]),'segmentation_confidence':segment.get('confidence')})
        if segment.get('weight'):
            record['weight_candidate'] = segment['weight']
            record['warnings'].append('Confirm scale OCR before using this weight.')
        records.append(record)
    summary = {k:v for k,v in result.items() if k not in ('segments','processing_manifest','original')}
    # Local filesystem paths never leave this Mac.
    summary = {k:summary[k] for k in ('duration','transcript','warnings') if k in summary}
    return summary, records

class Lease:
    def __init__(self, client, job):
        self.client,self.job = client,job
        self.stop = threading.Event()
        self.lost = False
    def __enter__(self):
        def heartbeat():
            while not self.stop.wait(20):
                try:
                    self.client.request('/api/worker/heartbeat', {'id':self.job['id'],'lease_token':self.job['lease_token'],'worker_id':self.job['worker_id']})
                except Exception:
                    self.lost = True
                    return
        self.thread = threading.Thread(target=heartbeat,daemon=True)
        self.thread.start()
        return self
    def __exit__(self,*args):
        self.stop.set()
        self.thread.join(2)

def run_once(client, cache=CACHE, worker_id=None):
    worker_id = worker_id or 'mac-'+str(uuid.uuid4())
    response = client.request('/api/worker/claim', {'worker_id':worker_id})
    job = response.get('job')
    if not job: return False
    identifier = safe_id(job.get('id'))
    job['worker_id'] = worker_id
    if not job.get('lease_token'): raise BridgeError('Website did not provide a processing lease.')
    folder = cache / identifier
    folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(cache,0o700)
    os.chmod(folder,0o700)
    try:
        with Lease(client,job) as lease:
            result, records = process(client,job,response.get('settings',{}),folder)
            if lease.lost: raise BridgeError('Processing lease interrupted. The website will safely retry the job.')
            client.request('/api/worker/complete',{'id':identifier,'lease_token':job['lease_token'],'worker_id':worker_id,'result':result,'records':records})
        shutil.rmtree(folder)
    except Exception as error:
        # Do not forward raw exceptions: URLs or tokens may appear in HTTP errors.
        message = 'Local processing could not finish. Your cloud original is preserved; check Mac AI readiness or retry.'
        if isinstance(error,BridgeError): message = str(error)
        try: client.request('/api/worker/fail',{'id':identifier,'lease_token':job['lease_token'],'worker_id':worker_id,'error':message})
        except Exception: pass
        shutil.rmtree(folder,ignore_errors=True)
        print('A job needs attention. Open Seller Hub → Activity.', flush=True)
    return True

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config',type=Path,default=CONFIG)
    parser.add_argument('--once',action='store_true')
    parser.add_argument('--allow-local-test',action='store_true',help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        config = load_config(args.config) if not (os.environ.get('MM_CLOUD_URL') and os.environ.get('MM_WORKER_TOKEN')) else {}
        client = Client(os.environ.get('MM_CLOUD_URL') or config.get('url',''),os.environ.get('MM_WORKER_TOKEN') or config.get('token',''),allow_local=args.allow_local_test)
        CACHE.mkdir(parents=True,exist_ok=True,mode=0o700)
        print('Mineral Murals AI ready. Leave this Mac awake; your phone can use the hosted website anywhere.',flush=True)
        worker_id = 'mac-'+str(uuid.uuid4())
        while True:
            try: busy = run_once(client, worker_id=worker_id)
            except Exception:
                print('Website temporarily unavailable. Retrying securely.',flush=True)
                busy = False
            if args.once: return
            time.sleep(1 if busy else 10)
    except (BridgeError, ValueError, OSError) as error:
        print('Worker setup needs attention. '+str(error) if isinstance(error,BridgeError) else 'Worker setup needs attention. Check the private pairing file.',file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__': main()
