package com.habitat.launcher.logic

/**
 * Pure page ordering so it can be tested without Android. The known set is intentionally fixed:
 * a corrupted preference can never hide a page or invent one.
 */
object PageOrder {
    val known = listOf("ax", "apps", "computer", "habitat", "intelligence", "gaming", "device")

    fun normalize(saved: List<String>): List<String> {
        val seen = mutableSetOf<String>()
        val result = ArrayList<String>(known.size)
        for (id in saved) {
            if (id in known && seen.add(id)) result.add(id)
        }
        for (id in known) {
            if (seen.add(id)) result.add(id)
        }
        return result
    }

    fun fromCsv(csv: String?): List<String> =
        normalize(csv.orEmpty().split(",").map { it.trim() }.filter { it.isNotEmpty() })

    fun toCsv(order: List<String>): String = normalize(order).joinToString(",")

    fun move(order: List<String>, id: String, delta: Int): List<String> {
        val list = normalize(order).toMutableList()
        val index = list.indexOf(id)
        if (index < 0) return list
        val target = (index + delta).coerceIn(0, list.size - 1)
        if (target == index) return list
        list.removeAt(index)
        list.add(target, id)
        return list
    }
}
