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
 *   members   the blog's members, staff, and viewers the entitlement check admits (VIP). No
 *             entitlement service exists yet: the default checker admits nobody (fails closed)
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
 *   check({ subject, key }) → true | false (never throws: an error counts as "no")
 * 'none' — no entitlement service exists yet, so nobody outside the blog's members and staff is
 * admitted. A cached badge or a client claim is never authorization.
 */
function createEntitlementChecker({ provider = 'none', check = null } = {}) {
    if (typeof check === 'function') {
        return {
            provider: 'custom',
            async has(subject, key) {
                if (!subject || !key) return false;
                try { return (await check({ subject, key })) === true; } catch { return false; }
            },
        };
    }
    if (provider !== 'none') {
        // A provider name we do not implement must not silently admit anyone.
        console.warn(`[Blog] BLOG_ENTITLEMENTS_PROVIDER=${provider} is not implemented; members-only posts stay closed`);
    }
    return { provider: 'none', async has() { return false; } };
}

/**
 * Read decision for one post. → { allowed, status, reason }
 *   status 404 hides existence (drafts, private, deleted); 403 says "members only".
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
    if (viewer && viewer.subject && post.entitlement_key && await entitlements.has(viewer.subject, post.entitlement_key)) {
        return { allowed: true, status: 200, reason: 'entitled' };
    }
    return { allowed: false, status: 403, reason: 'members_only' };
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
