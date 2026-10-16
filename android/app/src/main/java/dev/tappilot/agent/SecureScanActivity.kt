package dev.tappilot.agent

import android.os.Bundle
import android.view.MotionEvent
import android.view.WindowManager
import com.journeyapps.barcodescanner.CaptureActivity

/** QR scanning is a user-only control; never expose a decoded pairing credential on screenshots. */
class SecureScanActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
    }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.flags and (MotionEvent.FLAG_WINDOW_IS_OBSCURED or MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED) != 0) return false
        return super.dispatchTouchEvent(event)
    }
}
