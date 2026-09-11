UPDATE "t_sessions" s SET "f_title" = sub.title, "f_title_seq" = sub.seq
FROM (
  SELECT DISTINCT ON (b.f_session_id) b.f_session_id,
         COALESCE(e.f_data::jsonb -> 'data' ->> 'title', e.f_data::jsonb ->> 'title') AS title,
         b.f_sequence AS seq
  FROM t_session_events b JOIN t_events e ON e.f_event_id = b.f_event_id
  WHERE e.f_type = 'session/title'
  ORDER BY b.f_session_id, b.f_sequence DESC
) sub
WHERE s.f_session_id = sub.f_session_id;
