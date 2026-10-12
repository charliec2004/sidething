# Device installation & recovery

SideThing is its own display app and Mac helper. It uses the device’s existing Linux kernel, drivers, Weston and Chromium. It does not launch DeskThing or a Thing Labs app, and needs no DeskThing desktop server.

The installer supports the tested Superbird layout: root ADB, a read-only 541,110,272-byte System A partition, supervisord’s Chromium program, and an 8 MB Amlogic logo resource partition. Unknown layouts fail before their boot logo is written. It does not root stock hardware, replace the kernel or write the bootloader.

`./device/install.sh` verifies the original system image and startup configuration. It then gives Chromium its own profile, starts SideThing’s local connecting page, disables the old media service/updater/ambient backlight service, replaces the boot bitmap with black, and removes the old Weston background. Firmware diagnostics are preserved. The root filesystem is returned to read-only.

Private backups live in:

```text
~/Library/Application Support/CarThing/backups/<registered-device>/
```

The `CarThing` support-folder and bundle identifier are retained for existing pairing compatibility. They are not DeskThing dependencies. Keep backups off GitHub.

Restore the original boot artwork, Weston background and startup configuration:

```sh
./device/restore.sh
```

Reboot afterward. Restoration leaves the backed-up system image available; this script does not flash it.

For an existing backup, set `CARTHING_BACKUP_DIR` to its absolute directory. It must contain `system-a.img`, `supervisord.conf` and `backup.json` with the matching serial, byte count, system SHA-256 and startup SHA-256. Original startup assets are backed up separately before branding changes.
