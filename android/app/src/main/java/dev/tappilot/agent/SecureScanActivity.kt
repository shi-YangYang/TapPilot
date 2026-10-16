package dev.tappilot.agent

import android.os.Bundle
import android.view.MotionEvent
import android.view.WindowManager
import com.journeyapps.barcodescanner.CaptureActivity

/** QR scanning is a user-only control; never expose a decoded pairing credential on screenshots. */
class SecureScanActivity : CaptureActivity() {
    private lateinit var protectedTouch: ProtectedTouchGuard

    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        protectedTouch = ProtectedTouchGuard.forWindow(window)
        super.onCreate(savedInstanceState)
    }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        return protectedTouch.dispatch(event) { super.dispatchTouchEvent(it) }
    }
}
