package com.habitat

import android.app.job.JobParameters
import android.app.job.JobService
import java.util.concurrent.atomic.AtomicBoolean

class DeviceBridgeJobService : JobService() {
    @Volatile private var activeRun: AtomicBoolean? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val cancelled = AtomicBoolean(false)
        activeRun = cancelled
        Thread {
            try {
                AndroidDeviceBridge(applicationContext) {}.pollOnceNow()
            } finally {
                if (!cancelled.get()) jobFinished(params, false)
            }
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        activeRun?.set(true)
        return true
    }
}
