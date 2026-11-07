-- phase: migrate
-- Every post that existed before sharing is registered once, so canView has a row for all of them.
--
--   state draft | scheduled | unpublished   → private  (Only me until the author says otherwise)
--   state published, visibility public       → public   (Everyone)
--   state published, visibility unlisted     → link
--   state published, visibility members/private → private (members stays the VIP gate in the column)
--
-- The owner is the author's subject. A post with no usable author (an imported or AI post) gets Blog
-- itself, which nobody can sign in as. Deleted posts are not registered.
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'blog', 'post', p.id,
    CASE
        WHEN p.author_subject LIKE 'usr\_%' THEN jsonb_build_object('type', 'user', 'id', p.author_subject)
        WHEN p.author_subject LIKE 'gst\_%' THEN jsonb_build_object('type', 'guest', 'id', p.author_subject)
        ELSE jsonb_build_object('type', 'service', 'id', 'blog')
    END,
    CASE
        WHEN p.state <> 'published' THEN 'private'
        WHEN p.visibility = 'public' THEN 'public'
        WHEN p.visibility = 'unlisted' THEN 'link'
        ELSE 'private'
    END
FROM blog_posts p
WHERE p.state <> 'deleted'
ON CONFLICT (service, kind, resource_id) DO NOTHING;
