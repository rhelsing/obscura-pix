import com.obscura.kit.AuthState
import com.obscura.kit.ConnectionState
import com.obscura.kit.ObscuraClient
import com.obscura.kit.ObscuraConfig
import com.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.File

private val API = System.getenv("OBSCURA_API_URL") ?: "https://obscura.barrelmaker.dev"
private val PASSWORD = "pushTester!xyz9"
private val STATE_DIR = File(System.getProperty("user.home"), ".cache/obscura-push-tester").apply { mkdirs() }
private val DB_PATH = File(STATE_DIR, "db.sqlite").absolutePath
private val STATE_FILE = File(STATE_DIR, "sender.json")

private fun loadState(): JSONObject =
    if (STATE_FILE.exists()) JSONObject(STATE_FILE.readText()) else JSONObject()

private fun saveState(s: JSONObject) {
    STATE_FILE.writeText(s.toString(2))
}

private fun client(): ObscuraClient =
    ObscuraClient(ObscuraConfig(apiUrl = API, deviceName = "PushTester", databasePath = DB_PATH))

private suspend fun loginOrRegister(c: ObscuraClient): JSONObject {
    val state = loadState()
    val username = state.optString("username", "")
    return if (username.isEmpty()) {
        val newName = "pushtester_${System.currentTimeMillis()}"
        println("Registering new sender: $newName")
        c.register(newName, PASSWORD)
        val out = JSONObject()
            .put("username", newName)
            .put("userId", c.userId)
            .put("deviceId", c.deviceId)
        saveState(out)
        out
    } else {
        println("Logging in as $username")
        c.login(username, PASSWORD)
        require(c.authState.value == AuthState.AUTHENTICATED) { "Login failed: ${c.authState.value}" }
        state
    }
}

private suspend fun connect(c: ObscuraClient) {
    c.connect()
    val deadline = System.currentTimeMillis() + 10_000
    while (c.connectionState.value != ConnectionState.CONNECTED && System.currentTimeMillis() < deadline) {
        delay(200)
    }
    require(c.connectionState.value == ConnectionState.CONNECTED) {
        "Failed to connect, state=${c.connectionState.value}"
    }
}

private fun usage(): Nothing {
    System.err.println(
        """
        push-sender — End-to-end push test sender for Obscura

        Commands:
          init                              Register a new sender account (idempotent; prints userId/username).
          whoami                            Print sender identity.
          befriend <userId> <username>      Send a friend request to the recipient.
          accept-pending                    Accept all pending friend requests (drains for 5s).
          friends                           List friends and their status.
          send <recipientUsername> <text>   Send a TEXT message to a friend.
          ping <recipientUsername> [count]  Send "ping N <ts>" N times (default 1) with 500ms gaps.
        """.trimIndent()
    )
    kotlin.system.exitProcess(2)
}

fun main(args: Array<String>) {
    runBlocking { run(args) }
    // OkHttp's shared executor keeps non-daemon threads alive for ~60s after the last call,
    // blocking JVM exit. We're done — force-exit so each invocation returns promptly.
    kotlin.system.exitProcess(0)
}

private suspend fun run(args: Array<String>) {
    if (args.isEmpty()) usage()
    when (args[0]) {
        "init" -> {
            val c = client()
            val s = loginOrRegister(c)
            println("Sender username: ${s.getString("username")}")
            println("Sender userId:   ${s.getString("userId")}")
            c.disconnect()
        }
        "whoami" -> {
            val s = loadState()
            if (s.isEmpty) println("(no state yet — run `init`)")
            else println(s.toString(2))
        }
        "befriend" -> {
            if (args.size < 3) usage()
            val targetUserId = args[1]; val targetUsername = args[2]
            val c = client()
            loginOrRegister(c)
            connect(c)
            c.befriend(targetUserId, targetUsername)
            println("Friend request sent to $targetUsername ($targetUserId). Accept it on the phone.")
            delay(1000)
            c.disconnect()
        }
        "accept-pending" -> {
            val c = client()
            loginOrRegister(c)
            connect(c)
            // Drain any incoming messages (FRIEND_REQUEST etc.) for 5s
            val deadline = System.currentTimeMillis() + 5_000
            while (System.currentTimeMillis() < deadline) {
                try { c.waitForMessage(500) } catch (_: Exception) {}
            }
            val pending = c.pendingRequests.value
            if (pending.isEmpty()) {
                println("No pending requests.")
            } else {
                for (p in pending) {
                    println("Accepting friend request from ${p.username} (${p.userId})")
                    c.acceptFriend(p.userId, p.username)
                    delay(300)
                }
            }
            c.disconnect()
        }
        "friends" -> {
            val c = client()
            loginOrRegister(c)
            connect(c)
            delay(1000)
            val list = c.friendList.value
            if (list.isEmpty()) println("(no friends)")
            list.forEach { println("  ${it.username}  ${it.userId}  ${it.status}") }
            c.disconnect()
        }
        "send" -> {
            if (args.size < 3) usage()
            val recipientUsername = args[1]
            val text = args.drop(2).joinToString(" ")
            val c = client()
            loginOrRegister(c)
            connect(c)
            // Ensure friend list is hydrated (rebuildDeviceMap runs on connect)
            delay(800)
            val friend = c.friendList.value.find {
                it.username == recipientUsername && it.status == FriendStatus.ACCEPTED
            } ?: run {
                System.err.println("Not friends with $recipientUsername. Run `befriend` first.")
                c.disconnect()
                kotlin.system.exitProcess(1)
            }
            println("Sending to ${friend.username} (${friend.userId}): \"$text\"")
            c.send(recipientUsername, text)
            delay(1500) // let it flush
            println("Sent.")
            c.disconnect()
        }
        "ping" -> {
            if (args.size < 2) usage()
            val recipientUsername = args[1]
            val count = args.getOrNull(2)?.toIntOrNull() ?: 1
            val c = client()
            loginOrRegister(c)
            connect(c)
            delay(800)
            repeat(count) { i ->
                val text = "ping ${i + 1}/$count @ ${System.currentTimeMillis()}"
                println("→ $text")
                // Send as MODEL_SYNC directMessage (modern wire path) so the receiver's
                // bridge recognizes it for both UI delivery and notification posting.
                // The legacy TEXT path (c.send w/o an ORM model defined) is silently dropped
                // by the pix app — only MODEL_SYNC + MODEL_SIGNAL are wired up there.
                val friend = c.friendList.value.find { it.username == recipientUsername }
                    ?: throw IllegalStateException("Not friends with $recipientUsername — run befriend first")
                val convId = listOf(c.userId ?: "", friend.userId).sorted().joinToString("_")
                c.sendModelSync(
                    recipientUsername,
                    model = "directMessage",
                    entryId = java.util.UUID.randomUUID().toString(),
                    op = "CREATE",
                    data = mapOf(
                        "conversationId" to convId,
                        "content" to text,
                        "senderUsername" to (c.username ?: ""),
                    ),
                )
                delay(500)
            }
            delay(1500)
            c.disconnect()
        }
        else -> usage()
    }
}
