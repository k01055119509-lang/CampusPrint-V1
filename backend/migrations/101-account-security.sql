CREATE TABLE user_security (
 userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version >= 1),
 questionsJson TEXT NOT NULL CHECK(json_valid(questionsJson) AND json_array_length(questionsJson) = 3),
 updatedAt TEXT NOT NULL
) STRICT;
