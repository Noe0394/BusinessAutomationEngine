package com.cyrusmobile

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.flipper.ReactNativeFlipper
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(this.applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    ReactNativeFlipper.initializeFlipper(this, reactNativeHost.reactInstanceManager)

    // Demarre le service de premier plan des le lancement de l'appli, pour
    // que le processus survive au passage en arriere-plan. Couvre les deux
    // moteurs WhatsApp qui ont tourne dans ce process au fil du projet : le
    // thread Node embarque (Baileys, bloque - voir CLAUDE.md) et surtout la
    // WebView du moteur actuel (WhatsAppWebEngine.tsx), qui doit continuer
    // d'executer son JS pour recevoir les messages meme app en arriere-plan.
    // Pas de bridge natif dedie : plus simple pour ce spike, quitte a
    // affiner plus tard (ex: ne demarrer qu'une fois connecte a WhatsApp).
    val serviceIntent = Intent(this, KeepAliveService::class.java)
    ContextCompat.startForegroundService(this, serviceIntent)
  }
}
