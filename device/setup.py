#!/usr/bin/env python3
"""Register a supported device and save verified private recovery files."""
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
ADB = os.environ.get('CARTHING_ADB_BIN', str(ROOT / 'CarThing.app/Contents/Resources/adb'))
DATA = Path(os.environ.get('CARTHING_DATA_DIR', str(Path.home() / 'Library/Application Support/CarThing')))

def fail(message):
    raise SystemExit(message)

def adb(*args, timeout=30):
    return subprocess.check_output([ADB, *args], timeout=timeout)

def read_file(serial, remote):
    with tempfile.TemporaryDirectory(prefix="sidething-backup-") as scratch:
        path = Path(scratch) / "original"
        adb("-s", serial, "pull", remote, str(path))
        return path.read_bytes()

def shell(serial, command):
    return adb('-s', serial, 'shell', command).decode().strip()

def private_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)

def profile():
    p = DATA / 'device.json'
    if not p.exists(): fail('Run ./setup.sh first.')
    value = json.loads(p.read_text())
    if not re.fullmatch(r'[A-Za-z0-9]{6,40}', value.get('serial', '')): fail('Invalid registered device.')
    return value

def supported(serial):
    if shell(serial, 'id -u') != '0': fail('Car Thing must already have root ADB access; this project does not root or flash devices.')
    if shell(serial, 'uname -m') != 'aarch64': fail('Unsupported device architecture.')
    markers = 'test -d /usr/share/qt-superbird-app && test -b /dev/system_a && test -b /dev/system_b && test -f /etc/supervisord.conf && test -f /sys/class/backlight/aml-bl/brightness && echo supported'
    if shell(serial, markers) != 'supported': fail('Expected a Superbird with the Chromium/supervisord display stack.')

def register():
    lines = adb('devices').decode().splitlines()[1:]
    candidates = [line.split()[0] for line in lines if len(line.split()) >= 2 and line.split()[1] == 'device']
    if len(candidates) != 1: fail('Connect exactly one rooted Car Thing by USB, then run ./setup.sh again.')
    serial = candidates[0]
    if not re.fullmatch(r'[A-Za-z0-9]{6,40}', serial): fail('Unexpected device serial.')
    supported(serial)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA.chmod(0o700)
    value = profile() if (DATA / 'device.json').exists() else {'serial': serial, 'brightness': 92}
    if value['serial'] != serial: fail('Another device is already registered; it was not replaced.')
    private_json(DATA / 'device.json', value)
    print('Compatible Car Thing registered. Pairing credentials stay on this Mac.')

def backup(verify_only=False):
    serial = profile()['serial']
    folder = Path(os.environ.get('CARTHING_BACKUP_DIR', str(DATA / 'backups' / serial)))
    meta = folder / 'backup.json'
    image = folder / 'system-a.img'
    config = folder / 'supervisord.conf'
    if meta.exists():
        value = json.loads(meta.read_text())
        if value.get('serial') != serial or not config.is_file() or not image.is_file(): fail('Backup does not match the registered device.')
        with image.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hash_stream(stream)
        if digest != value.get('sha256') or image.stat().st_size != value.get('bytes'): fail('Backup checksum verification failed.')
        if hashlib.sha256(config.read_bytes()).hexdigest() != value.get('startup_sha256'): fail('Startup backup checksum verification failed.')
        print('Original device backup verified.'); return
    if verify_only: fail('No verified original backup. Run ./device/install.sh first.')
    supported(serial)
    original = read_file(serial, '/etc/supervisord.conf')
    parsed = configparser.ConfigParser(interpolation=None); parsed.read_string(original.decode())
    command = parsed.get('program:chromium', 'command', fallback='')
    if '--app=file:///usr/share/qt-superbird-app/webapp/index.html' not in command: fail('Startup is already customized. Supply its existing original backup with CARTHING_BACKUP_DIR; it will not be overwritten.')
    device_root = shell(serial, 'readlink -f /dev/root')
    if device_root != '/dev/system_a': fail('Only a read-only System A layout is currently supported.')
    mounts = shell(serial, 'cat /proc/mounts').splitlines()
    if not any(len(row.split()) > 3 and row.split()[1] == '/' and 'ro' in row.split()[3].split(',') for row in mounts): fail('Root must be read-only before backup.')
    folder.mkdir(parents=True, exist_ok=True, mode=0o700); folder.chmod(0o700)
    config.write_bytes(original); config.chmod(0o600)
    temp = image.with_suffix('.partial')
    print('Backing up original System A (about 540 MB). This may take a few minutes.', flush=True)
    available = int(shell(serial, 'df -Pk /var').splitlines()[-1].split()[3]) * 1024
    if available < 650_000_000: fail('The device needs 650 MB free in /var for its temporary backup.')
    adb('-s', serial, 'shell', 'mkdir -p /var/carthing; dd if=/dev/system_a of=/var/carthing/system-a.backup.img bs=1048576', timeout=600)
    adb('-s', serial, 'pull', '/var/carthing/system-a.backup.img', str(temp), timeout=600)
    temp.chmod(0o600)
    with temp.open('rb') as stream: digest = hash_stream(stream)
    remote_digest = shell(serial, 'sha256sum /dev/system_a').split()[0]
    if temp.stat().st_size != 541110272 or digest != remote_digest: fail('Backup did not match the device. Startup was not changed.')
    temp.replace(image)
    adb('-s',serial,'shell','rm -f /var/carthing/system-a.backup.img')
    private_json(meta, {'serial': serial, 'sha256': digest, 'bytes': image.stat().st_size, 'startup_sha256': hashlib.sha256(original).hexdigest(), 'original_startup': 'supervisord.conf', 'root_image': 'system-a.img'})
    print('Original device backup saved and verified.')

def hash_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()

if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['register']: register()
        elif sys.argv[1:] == ['backup']: backup()
        elif sys.argv[1:] == ['verify-backup']: backup(True)
        else: fail('Usage: device/setup.py register | backup | verify-backup')
    except (OSError, ValueError, configparser.Error, subprocess.SubprocessError) as error:
        fail('Setup failed: ' + str(error))
