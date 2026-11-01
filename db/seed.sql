-- Demo data. Bookings are created relative to "tomorrow" in the salon's timezone,
-- so the demo always has something to show.
set time zone 'Europe/Warsaw';

insert into users (name) values ('Ewa'), ('Kasia');

insert into clients (name) values ('Anna'), ('Marta'), ('Julia');

insert into bookings (user_id, client_id, service, start_at, end_at)
select u.id, c.id, b.service,
       (current_date + 1) + b.start_time,
       (current_date + 1) + b.end_time
from (values
  ('Ewa',   'Anna',  'Haircut',  time '10:00', time '10:45'),
  ('Ewa',   'Marta', 'Coloring', time '11:00', time '13:00'),
  ('Ewa',   'Julia', 'Manicure', time '15:00', time '16:00'),
  ('Kasia', 'Anna',  'Pedicure', time '12:00', time '13:00')
) as b (user_name, client_name, service, start_time, end_time)
join users u on u.name = b.user_name
join clients c on c.name = b.client_name
order by u.id, b.start_time;
