"""add file_type to papers for markdown support

Revision ID: e8a1f2c3b4d5
Revises: d4e5f6a7b8c9d0
Create Date: 2026-08-27
"""
from alembic import op
import sqlalchemy as sa

revision = "e8a1f2c3b4d5"
down_revision = "d4e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("papers", schema=None) as batch_op:
        batch_op.add_column(sa.Column("file_type", sa.Text(), nullable=False, server_default="pdf"))
        batch_op.add_column(sa.Column("orig_filename", sa.Text(), nullable=True))
        batch_op.create_index("ix_papers_file_type", ["file_type"])


def downgrade() -> None:
    with op.batch_alter_table("papers", schema=None) as batch_op:
        batch_op.drop_index("ix_papers_file_type")
        batch_op.drop_column("orig_filename")
        batch_op.drop_column("file_type")
