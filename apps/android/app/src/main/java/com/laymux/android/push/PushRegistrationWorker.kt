package com.laymux.android.push

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Token refresh must survive Firebase's short callback/process lifetime. */
class PushRegistrationWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (PushCloudClient(applicationContext).synchronize()) Result.success()
        else if (runAttemptCount < 3) Result.retry() else Result.failure()
    }
    companion object {
        fun enqueue(context: Context) {
            if (PushNotifications.configurations(context).isEmpty()) return
            val work = OneTimeWorkRequestBuilder<PushRegistrationWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(context).enqueueUniqueWork("laymux-push-registration", ExistingWorkPolicy.REPLACE, work)
        }
    }
}
