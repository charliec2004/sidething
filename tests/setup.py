"""Safety checks for device selection and backup handling, with no USB writes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('setup', Path(__file__).resolve().parents[1] / 'device/setup.py')
setup = importlib.util.module_from_spec(spec); spec.loader.exec_module(setup)

class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='carthing-setup-test-')
        self.data = Path(self.temp.name)
        self.patch = patch.object(setup, 'DATA', self.data); self.patch.start()
    def tearDown(self):
        self.patch.stop(); self.temp.cleanup()
    def registered(self, serial='ABC123'):
        (self.data / 'device.json').write_text(json.dumps({'serial': serial, 'brightness': 80}))
    def test_ambiguous_devices_are_not_registered(self):
        with patch.object(setup, 'adb', return_value=b'List of devices attached\nABC123\tdevice\nDEF456\tdevice\n'):
            with self.assertRaisesRegex(SystemExit, 'exactly one'): setup.register()
        self.assertFalse((self.data / 'device.json').exists())
    def test_existing_registration_is_not_replaced(self):
        self.registered()
        with patch.object(setup, 'adb', return_value=b'List of devices attached\nDEF456\tdevice\n'), patch.object(setup, 'supported'):
            with self.assertRaisesRegex(SystemExit, 'not replaced'): setup.register()
        self.assertEqual(json.loads((self.data / 'device.json').read_text())['serial'], 'ABC123')
    def test_unrooted_device_is_rejected(self):
        with patch.object(setup, 'shell', return_value='2000'):
            with self.assertRaisesRegex(SystemExit, 'root ADB'): setup.supported('ABC123')
    def test_custom_startup_is_not_backed_up_as_original(self):
        self.registered()
        current = b'[program:chromium]\ncommand=chromium --app=file:///var/carthing/boot.html\n'
        with patch.object(setup, 'supported'), patch.object(setup, 'read_file', return_value=current):
            with self.assertRaisesRegex(SystemExit, 'already customized'): setup.backup()
        self.assertFalse((self.data / 'backups').exists())
    def test_backup_serial_and_configuration_are_verified(self):
        self.registered(); folder = self.data / 'backups/ABC123'; folder.mkdir(parents=True)
        image = b'fixture image'; config = b'original configuration'
        (folder / 'system-a.img').write_bytes(image); (folder / 'supervisord.conf').write_bytes(config)
        metadata = {'serial':'DEF456','bytes':len(image),'sha256':hashlib.sha256(image).hexdigest(),'startup_sha256':hashlib.sha256(config).hexdigest()}
        (folder / 'backup.json').write_text(json.dumps(metadata))
        with self.assertRaisesRegex(SystemExit, 'does not match'): setup.backup(True)
        metadata['serial']='ABC123'; (folder / 'backup.json').write_text(json.dumps(metadata))
        (folder / 'supervisord.conf').write_bytes(b'changed startup')
        with self.assertRaisesRegex(SystemExit, 'Startup backup checksum'): setup.backup(True)

unittest.main()
