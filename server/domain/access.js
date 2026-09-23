'use strict';

/**
 * Who may read and write what. Pure decisions over (viewer, blog, post, membership); the routes
 * resolve the viewer (auth/viewer.js) and the data, then ask here.
 *
 * Viewers:
 *   { kind: 'anonymous' }
 *   { kind: 'user', subject: 'usr_…'|null, staff, user }             a browser or a Bearer user JWT
 *   { kind: 'service', service: 'svc:…', subject, origin, claims }   a Network service token; it acts
 *                                                                     for the person in X-OV-Subject
 * The acting person is `viewer.subject`. Staff = a Network admin (role claim) on a user token.
 *
 * Roles per blog (blog_memberships): owner > editor > author.
 *   owner   everything on the blog, including members, settings, theme and feeds
 *   editor  every post of the blog (write, publish, schedule, unpublish, delete)
 *   author  their own posts only
 * Staff: owner rights on the official blog; unpublish/delete (moderation) on every blog.
 *
 * Reading (visibility of a post):
 *   public    everyone once published
 *   unlisted  everyone with the link once published; never listed, fed, mapped or indexed
 *   members   the blog's members, staff, and viewers OpenVibe.VIP admits as members of the blog's
 *             owner (the entitlement checker below). Everyone else gets a teaser, never the body.
 *             The official blog has no owner in VIP: its members-only posts admit nobody else
 *   private   the blog's members and staff
 * Anything not published (draft, scheduled, unpublished) is readable by the blog's members
 * (authors: their own posts) and staff only. Deleted posts are readable by nobody.
 */

const ROLE_RANK = { author: 1, editor: 2, owner: 3 };

function roleOf(store, blogId, subject) {
    if (!subject) return null;
    const row = store.db.prepare('SELECT role FROM blog_memberships WHERE blog_id = ? AND subject = ?').get(blogId, subject);
    return row ? row.role : null;
}

/** Effective role of the viewer on a blog, staff included ('owner' on the official blog). */
function effectiveRole(store, viewer, blog) {
    const role = roleOf(store, blog.id, viewer && viewer.subject);
    if (viewer && viewer.staff && blog.kind === 'official') return 'owner';
    return role;
}

const atLeast = (role, min) => Boolean(role) && ROLE_RANK[role] >= ROLE_RANK[min];

function isStaff(viewer) { return Boolean(viewer && viewer.staff); }

/** Is this viewer a member of the blog who may see this (unpublished or restricted) post? */
function memberCanSee(store, viewer, blog, post) {
    const role = effectiveRole(store, viewer, blog);
    if (!role) return false;
    if (atLeast(role, 'editor')) return true;
    return post.author_subject === viewer.subject;
}

/**
 * The entitlement seam for members-only (VIP) posts.
 *   decide({ subject, blog, post }) → { allow, reason }   never throws: an error is a "no"
 *   has({ subject, blog, post })    → true | false
 * Providers:
 *   'vip'   OpenVibe.VIP decides (server/clients/vip.js: policies/evaluate, owner = the blog's owner,
 *           Blog's default gate member + blog:gated_post), through the VIP cache
 *   'none'  nobody outside the blog's members and staff is admitted
 *   check   (tests) a function ({ subject, key, blog, post }) → true
 * A cached badge or a client claim is never authorization. post.entitlement_key is informational
 * (it names the gate in Search ACLs); VIP decides.
 */
function createEntitlementChecker({ provider = 'none', check = null, vip = null } = {}) {
    const wrap = (name, decide) => ({
        provider: name,
        async decide(args) {
            if (!args || !args.subject) return { allow: false, reason: 'not_signed_in' };
            try {
                const d = await decide(args);
                return { allow: d.allow === true, reason: d.reason || (d.allow === true ? 'member' : 'denied') };
            } catch { return { allow: false, reason: 'error' }; }
        },
        async has(args) { return (await this.decide(args)).allow; },
    });
    if (typeof check === 'function') {
        return wrap('custom', async ({ subject, blog, post }) => ((await check({ subject, key: post && post.entitlement_key, blog, post })) === true
            ? { allow: true, reason: 'member' } : { allow: false, reason: 'not_a_member' }));
    }
    if (provider === 'vip') {
        if (vip && vip.enabled) return wrap('vip', (args) => vip.decide(args));
        console.warn('[Blog] BLOG_ENTITLEMENTS_PROVIDER=vip needs OV_OAUTH_CLIENT_SECRET; members-only posts stay closed');
        return wrap('none', async () => ({ allow: false, reason: 'vip_not_configured' }));
    }
    if (provider !== 'none') {
        // A provider name we do not implement must not silently admit anyone.
        console.warn(`[Blog] BLOG_ENTITLEMENTS_PROVIDER=${provider} is not implemented; members-only posts stay closed`);
    }
    return wrap('none', async () => ({ allow: false, reason: 'no_entitlement_service' }));
}

/**
 * Read decision for one post. → { allowed, status, reason, vip? }
 *   status 404 hides existence (drafts, private, deleted); 403 says "members only" (the caller shows
 *   a teaser and a join link, never the body); `vip` is the entitlement answer's reason.
 */
async function canReadPost(store, viewer, blog, post, entitlements) {
    if (!post || post.state === 'deleted') return { allowed: false, status: 404, reason: 'not_found' };
    if (blog.status !== 'active' && !isStaff(viewer)) return { allowed: false, status: 404, reason: 'blog_suspended' };
    const member = memberCanSee(store, viewer, blog, post) || isStaff(viewer);
    if (post.state !== 'published') return member ? { allowed: true, status: 200, reason: 'member' } : { allowed: false, status: 404, reason: 'not_published' };
    if (post.visibility === 'public' || post.visibility === 'unlisted') return { allowed: true, status: 200, reason: 'public' };
    if (member) return { allowed: true, status: 200, reason: 'member' };
    if (post.visibility === 'private') return { allowed: false, status: 404, reason: 'private' };
    // members (VIP): the entitlement check, failing closed.
    const d = await entitlements.decide({ subject: viewer && viewer.subject, blog, post });
    if (d.allow) return { allowed: true, status: 200, reason: 'entitled' };
    return { allowed: false, status: 403, reason: 'members_only', vip: d.reason };
}

/** Write decisions. action ∈ create | edit | publish | delete | configure | members. */
function canWrite(store, viewer, blog, action, post = null) {
    if (!viewer || !viewer.subject) return false;
    if (blog.status !== 'active' && !isStaff(viewer)) return false;
    const role = effectiveRole(store, viewer, blog);
    switch (action) {
    case 'create': return atLeast(role, 'author');
    case 'edit':
    case 'publish':
        if (atLeast(role, 'editor')) return true;
        return role === 'author' && post && post.author_subject === viewer.subject;
    case 'delete':
    case 'unpublish':
        if (isStaff(viewer)) return true; // moderation on any blog
        if (atLeast(role, 'editor')) return true;
        return role === 'author' && post && post.author_subject === viewer.subject;
    case 'configure':
    case 'members':
        return atLeast(role, 'owner');
    default:
        return false;
    }
}

module.exports = { ROLE_RANK, roleOf, effectiveRole, atLeast, isStaff, memberCanSee, canReadPost, canWrite, createEntitlementChecker };
