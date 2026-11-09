package com.habitat

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context

object DeviceBridgeScheduler {
    private const val JOB_ID = 27031
    private const val INTERVAL_MS = 15L * 60L * 1000L

    fun schedule(context: Context) {
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
        val job = JobInfo.Builder(
            JOB_ID,
            ComponentName(context, DeviceBridgeJobService::class.java)
        )
            .setPersisted(true)
            .setPeriodic(INTERVAL_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .build()
        scheduler.schedule(job)
    }

    fun cancel(context: Context) {
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
        scheduler.cancel(JOB_ID)
    }
}
