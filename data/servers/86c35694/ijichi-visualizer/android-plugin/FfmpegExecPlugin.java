package com.d4r.ijichivisualizer;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;

/**
 * FfmpegExecPlugin
 * -----------------
 * TIDAK memakai ffmpeg-kit (sudah discontinued per 2026).
 * Sebagai gantinya: binary ffmpeg statis di-bundle di assets/ffmpeg/<abi>/ffmpeg,
 * dicopy ke filesDir saat pertama jalan, lalu dieksekusi langsung lewat ProcessBuilder
 * seperti pakai ffmpeg di CLI biasa. Pendekatan ini lebih tahan lama karena tidak
 * bergantung pada library wrapper pihak ketiga yang bisa berhenti di-maintain.
 *
 * CATATAN SETUP (lihat README.md di root project):
 *  Taruh binary ffmpeg static build untuk Android di:
 *    android/app/src/main/assets/ffmpeg/arm64-v8a/ffmpeg
 *    android/app/src/main/assets/ffmpeg/armeabi-v7a/ffmpeg
 *  (sumber build statis ffmpeg utk android bisa dicari terpisah, banyak proyek
 *   open-source yang menyediakan build ini per ABI)
 */
@CapacitorPlugin(name = "FfmpegExec")
public class FfmpegExecPlugin extends Plugin {

    private static final String TAG = "FfmpegExec";

    @PluginMethod
    public void run(PluginCall call) {
        String framesDir = call.getString("framesDir");
        String audioPath = call.getString("audioPath");
        Integer fps = call.getInt("fps", 30);
        Integer width = call.getInt("width", 1280);
        Integer height = call.getInt("height", 720);
        String outputName = call.getString("outputName", "output.mp4");

        if (framesDir == null || audioPath == null) {
            call.reject("framesDir dan audioPath wajib diisi");
            return;
        }

        try {
            String ffmpegBin = ensureFfmpegBinary();
            File outDir = getContext().getExternalFilesDir("videos");
            if (outDir != null && !outDir.exists()) outDir.mkdirs();
            String outputPath = new File(outDir, outputName).getAbsolutePath();

            List<String> cmd = new ArrayList<>();
            cmd.add(ffmpegBin);
            cmd.add("-y");
            cmd.add("-framerate"); cmd.add(String.valueOf(fps));
            cmd.add("-i"); cmd.add(framesDir + "/frame_%06d.jpg");
            cmd.add("-i"); cmd.add(audioPath);
            cmd.add("-c:v"); cmd.add("libx264");
            cmd.add("-pix_fmt"); cmd.add("yuv420p");
            cmd.add("-vf"); cmd.add("scale=" + width + ":" + height);
            cmd.add("-c:a"); cmd.add("aac");
            cmd.add("-b:a"); cmd.add("192k");
            cmd.add("-shortest");
            cmd.add(outputPath);

            Log.d(TAG, "Running: " + cmd);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            Process process = pb.start();

            StringBuilder logOut = new StringBuilder();
            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            String line;
            while ((line = reader.readLine()) != null) {
                logOut.append(line).append('\n');
                // ffmpeg log baris terakhir aja yg disimpan buat hemat memori
                if (logOut.length() > 8000) logOut.delete(0, logOut.length() - 8000);
            }
            int exitCode = process.waitFor();

            if (exitCode != 0) {
                call.reject("ffmpeg exit code " + exitCode + "\n" + logOut.toString());
                return;
            }

            JSObject ret = new JSObject();
            ret.put("outputPath", outputPath);
            call.resolve(ret);

        } catch (Exception e) {
            Log.e(TAG, "encode error", e);
            call.reject("Encode error: " + e.getMessage());
        }
    }

    /** Copy binary ffmpeg dari assets sesuai ABI device ke filesDir, chmod +x, cache hasilnya. */
    private String ensureFfmpegBinary() throws Exception {
        Context context = getContext();
        File destDir = new File(context.getFilesDir(), "bin");
        if (!destDir.exists()) destDir.mkdirs();
        File dest = new File(destDir, "ffmpeg");

        if (!dest.exists()) {
            String abi = pickSupportedAbi();
            String assetPath = "ffmpeg/" + abi + "/ffmpeg";
            InputStream in = context.getAssets().open(assetPath);
            FileOutputStream out = new FileOutputStream(dest);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            out.close();
        }
        dest.setExecutable(true, false);
        dest.setReadable(true, false);
        return dest.getAbsolutePath();
    }

    private String pickSupportedAbi() {
        for (String abi : Build.SUPPORTED_ABIS) {
            if (abi.equals("arm64-v8a") || abi.equals("armeabi-v7a")) {
                return abi;
            }
        }
        return "arm64-v8a"; // fallback default
    }
}
