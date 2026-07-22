import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '@ash/contracts'

/**
 * In-platform notifications (SRS A-6) — «جرس بعداد داخل المنصة».
 *
 * A bell with a counter. Push is section M (Bundle 3); this is the seam it will hang off. Every
 * user reads only their OWN notifications, so there is no branch scoping to get wrong — the
 * recipient id is the actor's own id, never a parameter.
 */
export function registerNotificationRoutes(app: FastifyInstance, deps: Deps): void {
  // Any authenticated user has a bell; the permission is null (authentication only), and the
  // handler scopes every read to `req.actor.userId`.
  /** The recipient ids a user's bell surfaces: their own, plus their branch's shared bell. */
  const recipientsFor = (actor: { userId: string; branchId: string | null }): string[] =>
    actor.branchId ? [actor.userId, `branch:${actor.branchId}`] : [actor.userId]

  app.get('/notifications', { config: { permission: null } }, async (req, reply) => {
    if (!req.actor) return reply.code(401).send({ error: 'unauthenticated' })
    const { unreadOnly } = z.object({ unreadOnly: z.coerce.boolean().default(false) }).parse(req.query)

    const recipients = recipientsFor(req.actor)
    const rows = (await Promise.all(recipients.map((r) => deps.notifications.listForRecipient(r, unreadOnly))))
      .flat()
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
    const counts = await Promise.all(recipients.map((r) => deps.notifications.unreadCount(r)))

    return {
      unreadCount: counts.reduce((a, c) => a + c, 0),
      notifications: rows.map((n) => ({
        id: n.id,
        recipientId: n.recipientId,
        kind: n.kind,
        payload: n.payload,
        read: n.readAtMs !== null,
        createdAt: new Date(n.createdAtMs).toISOString(),
      })),
    }
  })

  app.post('/notifications/:id/read', { config: { permission: null } }, async (req, reply) => {
    if (!req.actor) return reply.code(401).send({ error: 'unauthenticated' })
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params)
    // markRead is scoped to (id, recipientId), so it is a no-op unless the notification is one
    // the actor may see — either personally or via their branch. A user cannot read another
    // user's personal bell, and a branch bell is only reachable by that branch's members.
    for (const recipient of recipientsFor(req.actor)) {
      await deps.notifications.markRead(id, recipient, deps.clock.nowMs())
    }
    return { id, read: true }
  })
}
