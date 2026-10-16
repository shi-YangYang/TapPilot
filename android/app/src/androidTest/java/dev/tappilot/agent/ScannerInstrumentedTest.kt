package dev.tappilot.agent

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.view.WindowManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.CaptureManager
import dalvik.system.PathClassLoader
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScannerInstrumentedTest {
    @Test fun scannerDependenciesShipInTheApplicationApk() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationInfo
        val apkPaths = (listOf(app.sourceDir) + app.splitSourceDirs.orEmpty()).joinToString(File.pathSeparator)
        // Instrumentation also provides AndroidX. An isolated APK loader prevents it
        // from hiding a missing production dependency, as it did in the scanner crash.
        val loader = PathClassLoader(apkPaths, ClassLoader.getSystemClassLoader().parent)
        for (name in listOf("androidx.core.content.ContextCompat", "androidx.core.app.ActivityCompat")) {
            assertSame("$name must come from the application APK", loader, loader.loadClass(name).classLoader)
        }
    }

    @Test fun scannerLaunchesSecurelyAndPermissionDenialClosesIt() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent(instrumentation.targetContext, SecureScanActivity::class.java)
            .setAction(Intents.Scan.ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Intents.Scan.FORMATS, "QR_CODE")
            .putExtra(Intents.Scan.BEEP_ENABLED, false)
            .putExtra(Intents.Scan.BARCODE_IMAGE_ENABLED, false)
            .putExtra(Intents.Scan.ORIENTATION_LOCKED, false)
            .putExtra(Intents.Scan.SHOW_MISSING_CAMERA_PERMISSION_DIALOG, false)
        val activity = instrumentation.startActivitySync(intent) as SecureScanActivity
        try {
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertFalse(activity.isFinishing)
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertNotNull(activity.findViewById<com.journeyapps.barcodescanner.DecoratedBarcodeView>(com.google.zxing.client.android.R.id.zxing_barcode_scanner))
                activity.onRequestPermissionsResult(
                    CaptureManager.getCameraPermissionReqCode(),
                    arrayOf(Manifest.permission.CAMERA),
                    intArrayOf(PackageManager.PERMISSION_DENIED)
                )
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync { assertTrue(activity.isFinishing) }
        } finally {
            instrumentation.runOnMainSync { if (!activity.isFinishing) activity.finish() }
        }
    }
}
