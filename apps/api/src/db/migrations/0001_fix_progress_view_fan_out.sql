DROP VIEW "public"."v_user_module_progress";--> statement-breakpoint
CREATE VIEW "public"."v_user_module_progress" AS (SELECT u.id AS user_id, m.id AS module_id,
       agg.lessons_total,
       agg.lessons_done,
       agg.exercise_done,
       agg.quiz_passed,
       (agg.lessons_total = agg.lessons_done AND agg.exercise_done AND agg.quiz_passed) AS module_completed
FROM users u
CROSS JOIN modules m
CROSS JOIN LATERAL (
  SELECT
    (SELECT count(*) FROM lessons l WHERE l.module_id = m.id) AS lessons_total,
    (SELECT count(*) FROM lessons l
       JOIN user_lesson_progress ulp ON ulp.lesson_id = l.id AND ulp.user_id = u.id
      WHERE l.module_id = m.id AND ulp.status = 'completed') AS lessons_done,
    (SELECT bool_or(uep.status = 'completed') FROM exercises e
       JOIN user_exercise_progress uep ON uep.exercise_id = e.id AND uep.user_id = u.id
      WHERE e.module_id = m.id) AS exercise_done,
    (SELECT bool_or(qa.passed) FROM quizzes q
       JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.user_id = u.id
      WHERE q.module_id = m.id) AS quiz_passed
) agg);