UPDATE `t_sessions` SET
  `f_title` = (
    SELECT COALESCE(json_extract(e.`f_data`, '$.data.title'), json_extract(e.`f_data`, '$.title'))
    FROM `t_session_events` b JOIN `t_events` e ON e.`f_event_id` = b.`f_event_id`
    WHERE b.`f_session_id` = `t_sessions`.`f_session_id` AND e.`f_type` = 'session/title'
    ORDER BY b.`f_sequence` DESC LIMIT 1
  ),
  `f_title_seq` = (
    SELECT b.`f_sequence`
    FROM `t_session_events` b JOIN `t_events` e ON e.`f_event_id` = b.`f_event_id`
    WHERE b.`f_session_id` = `t_sessions`.`f_session_id` AND e.`f_type` = 'session/title'
    ORDER BY b.`f_sequence` DESC LIMIT 1
  );
