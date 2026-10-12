import importlib.util
from pathlib import Path
import struct
import sys
import unittest
import zlib
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
import branding

class LogoTests(unittest.TestCase):
    def resource(self):
        data=bytearray(8388608)
        struct.pack_into('<II8sIII',data,0,0,2,b'AML_RES!',192,2,16)
        for index,name,start in [(0,b'bootup_spotify',192),(1,b'bad_charger',768330)]:
            struct.pack_into('<7I4B32s',data,64+index*64,0x27051956,0,768138,start,0,128 if index==0 else 0,0,index,8,0,0,name)
            data[start:start+768138]=bytes([77+index])*768138
        return data
    def test_only_boot_bitmap_changes(self):
        original=self.resource();result=branding.blank_logo(original)
        self.assertEqual(len(result),len(original));self.assertEqual(result[:64],original[:64])
        self.assertEqual(result[128:192],original[128:192]);self.assertEqual(result[768330:],original[768330:])
        self.assertEqual(result[192:194],b'BM')
        offset=struct.unpack_from('<I',result,192+10)[0]
        self.assertEqual(result[192+offset:192+offset+768000],bytes(768000))
        self.assertEqual(struct.unpack_from('<I',result,64+24)[0],zlib.crc32(result[192:768330])&0xffffffff)
    def test_unknown_resource_fails_closed(self):
        bad=self.resource();bad[8:16]=b'INVALID!'
        with self.assertRaises(SystemExit):branding.blank_logo(bad)
    def test_out_of_bounds_bitmap_is_rejected(self):
        bad=self.resource();struct.pack_into('<I',bad,64+12,len(bad)-1)
        with self.assertRaises(SystemExit):branding.blank_logo(bad)

unittest.main()
