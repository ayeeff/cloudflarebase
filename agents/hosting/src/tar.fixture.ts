/**
 * A REAL gzipped tar produced by bsdtar, inlined so the reader is tested
 * against the format as another implementation writes it - a parser checked
 * only against its own writer proves nothing.
 *
 * It has the shape GitHub sends: one <owner>-<repo>-<sha>/ wrapper directory,
 * a build output directory, repository furniture that must never be
 * published, and a path too long for tar's 100-byte name field, which
 * therefore travels as a PAX extended header.
 */
export const TARBALL_BASE64 =
	'H4sIAIfffWoAA+2azY6bMBSFWVfqO2TZLsz4B7BUTStV6iy76QtUBN8AHYKRbZqJqj5ZF32kvkIdZRMREoaEWpPibwNESkxy' +
	'uOf4XkVualBIQSNRuswIZQJWd8G0YIw554vd0dI97i9ITBlnMU8wX2BCOY+CRRw4oNUmVfZWrv2c7pe7EXr1D/PSFO1yqudg' +
	'nP6J1T9ijHn9XXBS/zKvpYJJ1rC/R5IkZ/SnpFP/EY/jYIEDB8xc/z+/ftdSwNe1FG0F+vWrwDMneutflNpMuAkYn//2lHv/' +
	'd0Gv/oeOMMFzMD7/4yjGXn8X9Or/5eHjp88P4VpMs8Zg/hPWzX8a+fx3gs1/BalYg0/+WTLs/81jfmUGjM//hDLq/d8Fz9O/' +
	'rAU8hd/0ZWsM+j+NO/rzZDf/8f7/77H+vxc6hKdGKqPfE58EM+J0/5c2TZhpPcEa4/d/MaXM178LbP0vpdj++OmrfpacqX+t' +
	'wUzR/l/S/9PI9/9OOK3/fs9XmHV17RrD+78j/+eUe/93gfX/+4J8KKCq5P2dPfM5MCsOrT5F30FtUSXrHIlSQWakvazTNSAj' +
	'UdPqApkCUAGpsJ7RpNogWdvrthYKBMqKVKWZAdUNjdH+zxi5+f6/z1iDl8d0mtegjX1l1Sr7BoW0Katq/yDgsfMfxinh/6H+' +
	'hxur4GXQq5oAaC6e9hwzOv8jHCW3Pv8f3FhPVnlX3bbN/0zWWlYQVjJ/Q976/J8VZ///tZHqcVXJzZVdIB4//2ec+P7PBc/U' +
	'PyvD7cWN4KD/k6P5f4z9/M8Ju/9/2ch5t8hK7/wej8czG4LgLwGrArYAMgAA';
