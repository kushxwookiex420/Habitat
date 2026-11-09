package com.habitat

import android.app.job.JobParameters
import android.app.job.JobService

class DeviceBridgeJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            try {
                AndroidDeviceBridge(applicationContext) {}.pollOnceNow()
            } finally {
                jobFinished(params, false)
            }
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}
