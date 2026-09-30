package asia.qiwu.narutorpg;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** Ordered, bounded staging of an export; no public file is touched yet. */
final class FileExportSession {
    static final long MAX_BYTES = 256L * 1024 * 1024;
    static final int CHUNK_BYTES = 256 * 1024;
    final File file;
    final long size;
    final String fileName;
    final String mimeType;
    private FileOutputStream output;
    private long written;

    static long requireByteCount(Object value) throws IOException {
        if (!(value instanceof Number)) throw new IOException("缺少有效的文件字节数");
        double count = ((Number) value).doubleValue();
        if (Double.isNaN(count) || Double.isInfinite(count) || count < 0 || count > MAX_BYTES || count != Math.floor(count)) {
            throw new IOException("文件字节数或分片位置无效");
        }
        return ((Number) value).longValue();
    }

    FileExportSession(File directory, String name, String mime, long expectedSize) throws IOException {
        if (expectedSize < 0 || expectedSize > MAX_BYTES) throw new IOException("导出文件超过 256 MB 限制");
        fileName = name;
        mimeType = mime;
        size = expectedSize;
        file = File.createTempFile("naruto-export-", ".tmp", directory);
        output = new FileOutputStream(file);
    }

    void append(long offset, byte[] bytes) throws IOException {
        if (output == null || offset != written || bytes.length > CHUNK_BYTES || written + bytes.length > size) {
            throw new IOException("导出分片顺序或长度无效");
        }
        output.write(bytes);
        written += bytes.length;
    }

    void finish() throws IOException {
        if (output == null || written != size) throw new IOException("导出文件尚未完整传输");
        output.close();
        output = null;
    }

    void discard() {
        if (output != null) {
            try { output.close(); } catch (IOException ignored) { }
            output = null;
        }
        file.delete();
    }
}
