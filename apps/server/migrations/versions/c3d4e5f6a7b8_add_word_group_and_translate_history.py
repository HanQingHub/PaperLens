"""add word group_name and translate_history

Revision ID: c3d4e5f6a7b8
Revises: b5d2e8f41a76
Create Date: 2026-08-25
"""
from alembic import op
import sqlalchemy as sa

revision = "c3d4e5f6a7b8"
down_revision = "b5d2e8f41a76"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("words") as batch:
        batch.add_column(sa.Column("group_name", sa.Text(), nullable=True))
    op.create_table(
        "translate_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("word", sa.Text(), nullable=False),
        sa.Column("sentence", sa.Text()),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("result", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index("ix_translate_history_user", "translate_history", ["user_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_translate_history_user", table_name="translate_history")
    op.drop_table("translate_history")
    with op.batch_alter_table("words") as batch:
        batch.drop_column("group_name")
