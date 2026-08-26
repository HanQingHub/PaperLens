"""add word_groups independent table

Revision ID: d4e5f6a7b8c9d0
Revises: c3d4e5f6a7b8
Create Date: 2026-08-26
"""
from alembic import op
import sqlalchemy as sa

revision = "d4e5f6a7b8c9d0"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "word_groups",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("user_id", "name", name="uq_word_groups_user_name"),
    )
    op.create_index("ix_word_groups_user", "word_groups", ["user_id"])
    # Backfill: distinct group_name from words
    op.execute(
        """
        INSERT OR IGNORE INTO word_groups (user_id, name, created_at)
        SELECT DISTINCT user_id, group_name, datetime('now')
        FROM words
        WHERE group_name IS NOT NULL AND group_name != ''
        """
    )


def downgrade() -> None:
    op.drop_index("ix_word_groups_user", table_name="word_groups")
    op.drop_table("word_groups")
