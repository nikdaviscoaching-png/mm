"""Worker media references must obey the hosted store's actual role contract."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

SPEC = importlib.util.spec_from_file_location('review_bridge', Path(__file__).resolve().parents[1] / 'local-worker/bridge.py')
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class CloudMediaFixture:
    """Models core.saveMedia: an original image's src is a placeholder."""
    def __init__(self, source):
        self.source = source
        self.media = {}

    def download(self, path, destination):
        shutil.copyfile(self.source, destination)

    def upload(self, path, job, *, role='display', original=None):
        key = '/media/test-' + str(len(self.media)) + '/' + Path(path).name
        meta = {'role': role, 'original': original, 'path': key}
        self.media[key] = meta
        return {'src': '/assets/conversion-needed.svg' if role == 'original' else key,
                'original': original or key, 'preview_only': role == 'original'}

    def validate_photo(self, photo):
        display = self.media[photo['src']]
        assert display['role'] == 'display'
        assert photo['original'] == display['original']
        assert photo['original'].startswith('/media/')
        for provider in ('etsy', 'ebay'):
            derivative = self.media[photo['channel_' + provider]]
            assert derivative['role'] == 'channel_' + provider
            # Same invariant as cloud/store.js validPhotos.
            assert derivative['original'] == photo['original']


def record_stub(text, identifier, settings, photos=None, video=None, extra=None):
    return {'id': identifier, 'photos': photos or [], 'video': video}


class BridgeMediaContractTests(unittest.TestCase):
    def test_image_channel_derivatives_reference_the_same_private_original(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'camera.png'
            Image.new('RGB', (40, 30), '#618ebd').save(source)
            class Media:
                @staticmethod
                def convert_image(original, output):
                    shutil.copyfile(original, output)
                    return {'width': 40, 'height': 30}
            client = CloudMediaFixture(source)
            folder = root / 'job'
            folder.mkdir()
            with patch.object(bridge, 'modules', return_value=(Media, None)), patch.object(bridge, 'new_record', side_effect=record_stub):
                result, _ = bridge.process(client, {'id': 'image-job', 'kind': 'image', 'media': '/media/original/camera.png'}, {}, folder)
            client.validate_photo(result['photo'])

    def test_video_frame_uses_original_reference_instead_of_placeholder_src(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'movie.mov'
            source.write_bytes(b'video fixture')
            original = root / 'full-frame.png'
            crop = root / 'crop.png'
            Image.new('RGB', (60, 40), '#4988c4').save(original)
            Image.new('RGB', (30, 30), '#4988c4').save(crop)
            class Media:
                @staticmethod
                def process_video(*args):
                    return {'duration': 5, 'segments': [{'start': 1, 'end': 4,
                        'photos': [crop], 'original_photos': [original], 'transcript': 'Material agate.'}]}
            client = CloudMediaFixture(source)
            folder = root / 'job'
            folder.mkdir()
            with patch.object(bridge, 'modules', return_value=(Media, None)), patch.object(bridge, 'new_record', side_effect=record_stub):
                _, records = bridge.process(client, {'id': 'video-job', 'kind': 'video', 'media': '/media/original/movie.mov'}, {}, folder)
            photo = records[0]['photos'][0]
            client.validate_photo(photo)
            self.assertEqual(client.media[photo['original']]['role'], 'original')


if __name__ == '__main__':
    unittest.main()
