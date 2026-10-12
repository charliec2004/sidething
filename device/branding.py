#!/usr/bin/env python3
"""Own black startup: verified logo backup + Weston background, no app dependency."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import zlib
import setup


def blank_logo(original):
    # Amlogic resource format; modify only the boot bitmap, preserving diagnostics.
    data = bytearray(original)
    crc, version, magic, size, count, alignment = struct.unpack_from('<II8sIII', data)
    if (len(data), crc, version, magic, alignment) != (8388608, 0, 2, b'AML_RES!', 16) or not 1 <= count <= 32:
        setup.fail('Unsupported boot-logo resource format; no logo was written.')
    found = False
    for index in range(count):
        entry = 64 + index * 64
        header = struct.unpack_from('<7I4B32s', data, entry)
        length, start, name = header[2], header[3], header[-1].split(b'\0')[0]
        if header[0] != 0x27051956 or start < 64 + count * 64 or start + length > len(data):
            setup.fail('Invalid logo resource bounds.')
        if name != b'bootup_spotify': continue
        if found: setup.fail('Duplicate boot bitmap.')
        found = True
        # Fresh RGB565 BMP: a plain black screen, in the panel's native orientation.
        pixels = bytes(480 * 800 * 2)
        offset = 14 + 40 + 12
        bmp = struct.pack('<2sIHHI', b'BM', offset + len(pixels), 0, 0, offset)
        bmp += struct.pack('<IiiHHIIiiII', 40, 480, 800, 1, 16, 3, len(pixels), 0, 0, 0, 0)
        bmp += struct.pack('<III', 0xf800, 0x07e0, 0x001f) + pixels
        if len(bmp) > length: setup.fail('Boot bitmap does not fit.')
        data[start:start+length] = bmp + bytes(length-len(bmp))
        struct.pack_into('<I', data, entry+24, zlib.crc32(data[start:start+length]) & 0xffffffff)
    if not found: setup.fail('Boot bitmap missing; no logo was written.')
    return bytes(data)


def prepare():
    setup.backup(True)
    serial = setup.profile()['serial']
    folder = Path(setup.os.environ.get('CARTHING_BACKUP_DIR', str(setup.DATA / 'backups' / serial)))
    meta = json.loads((folder/'backup.json').read_text())
    for filename, remote in [('logo-original.img','/dev/logo'), ('aml-weston.ini','/etc/aml-weston.ini')]:
        path = folder/filename
        key = filename + '_sha256'
        if key not in meta:
            if filename.endswith('.img'):
                setup.adb('-s',serial,'shell','dd if=/dev/logo of=/var/carthing/logo.original.img bs=65536')
                setup.adb('-s',serial,'pull','/var/carthing/logo.original.img',str(path))
            else: path.write_bytes(setup.read_file(serial,remote))
            path.chmod(0o600)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != setup.shell(serial, 'sha256sum '+remote).split()[0]: setup.fail('Branding backup did not match the device.')
            meta[key] = digest
            setup.private_json(folder/'backup.json',meta)
        if hashlib.sha256(path.read_bytes()).hexdigest() != meta[key]: setup.fail('Branding backup checksum failed.')
    logo = blank_logo((folder/'logo-original.img').read_bytes())
    weston = (folder/'aml-weston.ini').read_text()
    lines = [line for line in weston.splitlines() if not line.startswith('background-image=')]
    lines = ['background-color=0xff090a0b' if line.startswith('background-color=') else line for line in lines]
    stage = folder/'sidething'; stage.mkdir(exist_ok=True,mode=0o700)
    (stage/'logo.img').write_bytes(logo); (stage/'weston.ini').write_text('\n'.join(lines)+'\n')
    print('Original startup assets verified; own black boot prepared.')
    return serial, folder


def install(restore=False):
    serial, folder = prepare()
    logo = folder/'logo-original.img' if restore else folder/'sidething/logo.img'
    weston = folder/'aml-weston.ini' if restore else folder/'sidething/weston.ini'
    setup.adb('-s',serial,'push',str(logo),'/var/carthing/logo.pending.img')
    setup.adb('-s',serial,'push',str(weston),'/var/carthing/weston.pending.ini')
    expected = hashlib.sha256(logo.read_bytes()).hexdigest()
    if setup.shell(serial, 'sha256sum /var/carthing/logo.pending.img').split()[0] != expected: setup.fail('Staged logo checksum failed.')
    # The logo is its own 8 MB asset partition; never touch the bootloader.
    partitions = [line.split() for line in setup.shell(serial, 'cat /proc/partitions').splitlines()]
    if ['179','7','8192','mmcblk0p7'] not in partitions: setup.fail('Unexpected logo partition size.')
    setup.adb('-s',serial,'shell','dd if=/var/carthing/logo.pending.img of=/dev/logo bs=65536 && sync')
    if setup.shell(serial, 'sha256sum /dev/logo').split()[0] != expected: setup.fail('Written logo checksum failed; restore the saved original before rebooting.')
    setup.adb('-s',serial,'shell','set -e; mount -o remount,rw /; trap "mount -o remount,ro /" EXIT; cp /var/carthing/weston.pending.ini /etc/aml-weston.sidething.new; chmod 644 /etc/aml-weston.sidething.new; mv /etc/aml-weston.sidething.new /etc/aml-weston.ini; sync')
    print('Original startup restored.' if restore else 'Own boot logo and plain Weston background installed; reboot to see them.')


if __name__ == '__main__':
    if sys.argv[1:] == ['prepare']: prepare()
    elif sys.argv[1:] == ['install']: install()
    elif sys.argv[1:] == ['restore']: install(True)
    else: setup.fail('Usage: device/branding.py prepare | install | restore')
