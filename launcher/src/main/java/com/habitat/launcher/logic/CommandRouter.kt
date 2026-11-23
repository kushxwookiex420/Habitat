package com.habitat.launcher.logic

/**
 * Commands are matched locally and never claim a device or server action. If nothing matches, the
 * UI must say so instead of pretending the command succeeded.
 */
sealed interface CommandResult {
    data class Navigate(val pageId: String) : CommandResult
    data class OpenApp(val query: String) : CommandResult
    data class WebSearch(val query: String) : CommandResult
    data class Reply(val message: String) : CommandResult
    data class Unsupported(val input: String) : CommandResult
}

object CommandRouter {
    private val pageAliases = linkedMapOf(
        "home" to "ax",
        "ax" to "ax",
        "apps" to "apps",
        "applications" to "apps",
        "computer" to "computer",
        "habitat" to "habitat",
        "workers" to "habitat",
        "intelligence" to "intelligence",
        "gaming" to "gaming",
        "games" to "gaming",
        "device" to "device",
        "settings" to "device"
    )

    fun route(raw: String): CommandResult {
        val input = raw.trim()
        if (input.isEmpty()) return CommandResult.Unsupported(input)
        val lower = input.lowercase()

        if (lower == "help" || lower == "?") {
            return CommandResult.Reply(
                "Try \"open camera\", \"go to habitat\", \"search android launcher\", or \"refresh habitat\"."
            )
        }
        if (lower == "refresh habitat" || lower == "refresh") {
            return CommandResult.Reply("Refreshing Habitat status.")
        }

        for ((alias, pageId) in pageAliases) {
            if (lower == alias || lower == "go to $alias" || lower == "open $alias") {
                return CommandResult.Navigate(pageId)
            }
        }
        if (lower.startsWith("search ")) {
            val query = input.substringAfter("search ").trim()
            return if (query.isEmpty()) CommandResult.Unsupported(input) else CommandResult.WebSearch(query)
        }
        if (lower.startsWith("open ")) {
            val query = input.substringAfter("open ").trim()
            return if (query.isEmpty()) CommandResult.Unsupported(input) else CommandResult.OpenApp(query)
        }
        return CommandResult.Unsupported(input)
    }
}
