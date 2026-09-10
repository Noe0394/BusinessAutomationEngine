package com.cyrusmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Service de premier plan minimal : son seul but est de garder le processus
 * de l'application (donc aussi le thread Node embarque par
 * nodejs-mobile-react-native, ou tourne Baileys) vivant quand l'appli passe
 * en arriere-plan. C'est le seul mecanisme fiable sur Android pour ca -
 * tenter de contourner Doze avec des wake-locks bricoles consommerait plus
 * de batterie pour un resultat moins sur.
 *
 * Ce service ne fait rien d'autre qu'afficher une notification persistante
 * discrete ; toute la logique WhatsApp reste dans nodejs-assets/nodejs-project.
 */
class KeepAliveService : Service() {

  companion object {
    private const val CHANNEL_ID = "cyrus_whatsapp_keepalive"
    private const val NOTIFICATION_ID = 1
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForeground(NOTIFICATION_ID, buildNotification())
    return START_STICKY
  }

  private fun buildNotification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      val channel = NotificationChannel(
        CHANNEL_ID,
        "WhatsApp (Cyrus Mobile)",
        NotificationManager.IMPORTANCE_MIN,
      )
      manager.createNotificationChannel(channel)
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("WhatsApp connecte")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .build()
  }
}
