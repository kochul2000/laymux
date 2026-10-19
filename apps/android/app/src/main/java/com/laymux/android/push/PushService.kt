package com.laymux.android.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class PushService : FirebaseMessagingService() {
    override fun onCreate() {
        PushNotifications.initialize(this)
        super.onCreate()
    }
    override fun onMessageReceived(message: RemoteMessage) {
        PushPayload.parse(message.data)?.let { PushNotifications.receive(this, it) }
    }
    override fun onNewToken(token: String) {
        // Retain intent locally even if Cloud login or network is unavailable;
        // foreground reconciliation retries the current token for every PC.
        PushNotifications.preferences(this).edit().putString("token", token).apply()
        PushRegistrationWorker.enqueue(this)
    }
}
