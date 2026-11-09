package com.habitat

import android.app.job.JobParameters
import android.app.job.JobService

class DeviceBridgeJobService : JobService() {
    @Volatile private var stopped = false

    override fun onStartJob(params: JobParameters): Boolean {
        stopped = false
        Thread {
            try {
                AndroidDeviceBridge(applicationContext) {}.pollOnceNow()
            } finally {
                if (!stopped) jobFinished(params, false)
            }
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        stopped = true
        return true
    }
}
