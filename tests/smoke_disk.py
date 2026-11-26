"""Self-check ước lượng dung lượng thẻ/USB (_disk_parts/_disk_used) bằng output mmls/fsstat mẫu, không cần ổ thật.
Chạy trong container be: docker exec -i mf-be python - < tests/smoke_disk.py"""
import types
import app.main as m

DOS = """DOS Partition Table
Units are in 512-byte sectors
      Slot      Start        End          Length       Description
000:  Meta      0000000000   0000000000   0000000001   Primary Table (#0)
001:  -------   0000000000   0000016383   0000016384   Unallocated
002:  000:000   0000016384   0001064959   0001048576   Win95 FAT32 (0x0c)
003:  000:001   0001064960   0060440575   0059375616   Linux (0x83)
"""
GPT = """GUID Partition Table (EFI)
000:  Meta      0000000000   0000000000   0000000001   Safety Table
002:  Meta      0000000001   0000000001   0000000001   GPT Header
004:  000       0000002048   0000206847   0000204800   EFI system partition
"""
FAT = "File System Type: FAT32\nFree Sector Count (FS Info): 879789\nTotal Range: 0 - 1048571\nRange: 2 - 16518534\nSector Size: 512\n"
EXT = ("File System Type: Ext4\nBlock Range: 0 - 7421951\nBlock Size: 4096\nFree Blocks: 6503877\n"
       "Group: 0:\n  Block Range: 0 - 32767\n  Free Blocks: 0 (0%)\n")


def run_with(mmls, fs):
    def fake(cmd, **kw):
        off = cmd[cmd.index("-o") + 1] if "-o" in cmd else None
        return types.SimpleNamespace(stdout=mmls if cmd[0] == "mmls" else fs.get(off, ""), returncode=0)
    m.subprocess.run = fake


real = m.subprocess.run
try:
    run_with(DOS, {"0000016384": FAT, "0001064960": EXT})
    assert m._disk_parts("/dev/x", 1) == [("0000016384", 1048576 * 512), ("0001064960", 59375616 * 512)]
    assert m._disk_used("/dev/x", 1) == (1048572 - 879789) * 512 + (7421952 - 6503877) * 4096  # ~86 MB + ~3.76 GB
    run_with(GPT, {"0000002048": ""})  # GPT + hệ tệp không có số trống -> tính cả phân vùng
    assert m._disk_parts("/dev/x", 1) == [("0000002048", 204800 * 512)]
    assert m._disk_used("/dev/x", 1) == 204800 * 512
    run_with("", {None: EXT})  # không có bảng phân vùng: cả ổ là 1 hệ tệp
    assert m._disk_parts("/dev/x", 999) == [(None, 999)]
    assert m._disk_used("/dev/x", 999) == (7421952 - 6503877) * 4096
finally:
    m.subprocess.run = real
print("OK smoke_disk")
