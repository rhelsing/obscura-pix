package com.obscuraapp

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.swmansion.rnscreens.fragment.restoration.RNScreensFragmentFactory

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "ObscuraApp"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * react-native-screens requires its own [androidx.fragment.app.FragmentFactory]
   * to be installed BEFORE super.onCreate so Android's fragment-state restoration
   * (process death, rotation, "Don't keep activities") rebuilds screen
   * fragments correctly instead of crashing.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    supportFragmentManager.fragmentFactory = RNScreensFragmentFactory()
    super.onCreate(savedInstanceState)
  }

  /**
   * Warm-start deep link: a notification tap (or any explicit launch intent)
   * arriving while the activity already exists. Cold-start deep-links are
   * pulled by JS via [ObscuraBridgeModule.getLaunchIntent] instead, because
   * the bridge isn't constructed yet at cold-start time.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    intent.getStringExtra("screen")?.let { screen ->
      ObscuraBridgeModule.deliverLaunchedFrom(screen)
    }
  }
}
